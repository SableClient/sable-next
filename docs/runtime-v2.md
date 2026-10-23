# The app runtime

`sable-runtime` holds the state the UI shows and the rules that change it. The UI keeps a copy of that state, kept up to date by patches.

A shell (web worker, Node, Tauri, React Native) connects the two. It gives the runtime a core, a platform and a clock, forwards the UI's calls, and delivers what the runtime sends back.

## Crates

| Crate                                                          | Role                                                                            | May depend on                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `sable-model`                                                  | Pure logic, no I/O                                                              | Nothing in the workspace                                       |
| `sable-protocol`                                               | Wire types: `CoreEvent`, `RpcError`, `VectorDiff`, the `*View` types            | `sable-model`                                                  |
| `sable-core`                                                   | The Matrix SDK, I/O and the RPC handlers                                        | `sable-model`, `sable-protocol`                                |
| `sable-runtime`                                                | Slices, instances, patches, requests, the outbox, persistence, the test harness | `sable-protocol`                                               |
| `sable-ffi`                                                    | One binding-neutral surface over `App`                                          | `sable-protocol`, `sable-runtime`                              |
| `sable-typegen`                                                | Writes `src/generated/protocol.ts` and the schema hash                          | `sable-core`, `sable-model`, `sable-protocol`, `sable-runtime` |
| Shells (`sable-wasm`, `sable-node`, `src-tauri`, `sable-push`) | Glue, a `Platform`, a `Backend` over the core                                   | Listed in `scripts/check/crate-edges.mjs`                      |

Only `sable-core` uses the Matrix SDK. Every other crate builds and tests without compiling it.

Two checks in `mise run check` enforce the table:

- `.cargo/deny.toml` bans `matrix-sdk` and `matrix-sdk-ui` everywhere except as dependencies of `sable-core`.
- `scripts/check/crate-edges.mjs` fails on any workspace dependency, or any direct `matrix-sdk*` dependency, that is not in its table. A new crate must be added to the table.

## Slices

A slice is a piece of state, the inputs that change it, and the commands it needs run. It is one type that implements `Slice`:

```rust
struct Room;

impl Slice for Room {
    const NAME: &'static str = "room";
    const LIFETIME: Lifetime = Lifetime::RefCounted { grace: Duration::from_secs(5) };

    type Key = String;                // names one instance; `()` for a singleton
    type State = ListDoc<u32>;        // everything the slice keeps
    type View = ListDoc<u32>;         // the part subscribers see
    type Action = RoomAction;         // what the UI sends; `Deserialize`
    type Input = RoomInput;           // what `reduce` handles; `From<Action>`

    fn init(room: &String, _cached: Option<Value>) -> (Self::State, Cmd<RoomInput>) {
        (ListDoc::new(Vec::new()), Cmd::rpc(OpenCall { room: room.clone() }, |_| RoomInput::Done))
    }
    fn view(state: &mut Self::State) -> &mut Self::View { state }
    fn reduce(_: &String, state: &mut Self::State, input: RoomInput, _: &Cx) -> Cmd<RoomInput> { /* ... */ }
    fn dispose(room: &String, _: &mut Self::State) -> Cmd<RoomInput> {
        Cmd::rpc(CloseCall { room: room.clone() }, |_| RoomInput::Done)
    }
}
```

`reduce` is synchronous. It changes the state and returns a `Cmd`.

Two items are optional:

- `INTEREST` lists the `CoreEventKind`s the slice wants. `core_input` turns each of those events into an input.
- `PERSIST` saves the view for the next cold start (see Persistence).

To add a slice, write its file and add one line where the app builds its registry:

```rust
registry.add::<Room>()?;
#[cfg(feature = "calls")]
registry.add::<Calls>()?;
```

`add` fails if the name is already registered. The handshake lists the registered names, so the UI learns at connect time if a slice it needs is missing.

## Commands

A `Cmd<I>` is data. `reduce` returns it and the runtime runs it afterwards.

| Command                                        | What it does                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Cmd::rpc(params, \|result\| input)`           | Calls the core through `Backend::run::<P: Rpc>`. Typed, with one JSON encode and decode. |
| `Cmd::task(\|ports\| async { Option<input> })` | Runs anything else, such as a platform or clock call.                                    |
| `Cmd::input(i)`                                | Reduces another input next.                                                              |
| `after(name, delay, input)`                    | Starts a timer, unless a timer with that name is already pending.                        |
| `debounce(name, delay, input)`                 | Starts a timer and replaces any pending one with that name.                              |
| `cancel(name)`                                 | Removes a pending timer.                                                                 |
| `stream(name, open)`                           | Reduces every item of a stream until it ends, is replaced, or the instance stops.        |
| `end_stream(name)`                             | Ends a stream.                                                                           |
| `notice(stage, text)`                          | Tells the user something that is not part of the state.                                  |
| `reply(req, result)`                           | Answers a request (see Requests).                                                        |
| `batch`, `then`                                | Combine commands, in order.                                                              |

Each instance tracks a generation for its timers. A timer message that was already queued when its timer was cancelled or replaced is ignored.

A slice can reduce at most 10 000 inputs per message. This stops a slice that keeps producing inputs from blocking its inbox.

## Instances

An instance runs one slice for one key. Each instance is its own task with an inbox of 256 messages. It reads messages in batches and publishes once per batch. A sender waits when the inbox is full.

There are two lifetimes:

- `Singleton`: starts on first use and lives until the account changes.
- `RefCounted { grace }`: lives while subscribers or calls hold it. When the last hold goes, the instance waits `grace`, then is disposed. It is not disposed while it has a request waiting. A subscriber that comes back within the grace period finds the instance still running.

Disposal runs the slice's `dispose` commands, drains them, saves the view, and answers any requests still open. `stop` returns only after all of this.

Two instances with the same id never run at the same time. While one stops, the host keeps its id reserved, and a new `acquire` waits for it.

`Followed<K, V>` is a refcounted map for a slice that serves many keys from a single instance.

## Requests

`app.request(target, action)` returns a `ReqId`. The slice reads it with `cx.req()`, carries it into the inputs that finish the request, and answers with `Cmd::reply`.

The shell receives `AppEvent::Reply` after the patches that the request caused.

A request ends exactly once, with one of:

- `Ok`
- an RPC error
- `Lost { reason }`, where the reason is:
  - `Expired`: no answer after 30 seconds.
  - `EpochChanged`: the account changed.
  - `InstanceStopped` or `InstanceFailed`: the instance went away.

A shell that restarts its worker rejects its own pending requests.

## Ticks, epochs and accounts

Every batch sent to the shell has a `tick` that counts up. The shell applies all events of one batch before drawing.

Patches, replies, notices, resyncs and snapshots carry the account `epoch`.

`App::new` takes the starting account. `switch_account(account)` changes it. Before it returns, it:

1. bumps the epoch,
2. disposes and stops every instance of the old account,
3. loses the old account's requests,
4. tells every subscriber to resync.

A reply that reaches the outbox from an old epoch becomes `Lost(EpochChanged)`. Patches, notices and resyncs from an old epoch are dropped.

Running effect tasks are not cancelled when their instance stops. Their results are discarded, but any call they already made still reaches the core. A shell must therefore:

- call `switch_account` before the core starts serving the new account, and
- either make the core reject calls for an account it has left, or hold the new backend back until `switch_account` returns.

## State, patches and windows

`Doc<V>` keeps no copy of what it has sent:

- `edit(path, f)` marks a JSON pointer as changed. Draining serializes once and sends only the changed paths.
- Overlapping paths are merged. A path into an array sends the whole array.
- `view_mut()` sends the whole view.
- An unchanged doc drains in constant time.
- A view that fails to serialize is an error, never `null`.

`ListDoc<T>` records `VectorDiff`s and encodes only the rows in a subscriber's `Window`. An edit that shifts the window becomes a single `Reset` of that window. Subscribers choose a window when they subscribe and move it with `range`. `None` follows the whole list.

A view with no subscribers that is not persisted is cleared without being serialized.

## Backpressure

For each subscription, the outbox holds at most:

- 1024 weighted ops (one per edit, one per row of a list op),
- 32 notices.

A batch holds at most 256 events.

When a subscriber goes over the cap, its queued patches are replaced by a single `Resync`. It gets nothing more until it calls `resync`. A slow shell costs extra resyncs rather than memory.

## Persistence

A slice with `PERSIST` gets its last saved view in `init`. It saves the view 2 seconds after a change and again on dispose. Writes happen one after another, in order.

- The storage key is `snapshot/<account>/<slice>/<key>`, so one account never starts from another account's view.
- The stored value is `{ schema, view }`. A view saved under a different `WIRE_SCHEMA` is not loaded.
- A view larger than 1 MiB is not saved.

The slice decides how to read a saved view, with `Doc::from_cached` or `ListDoc::from_cached`. A saved view that no longer fits is ignored.

## The wire and the handshake

The UI and the runtime must be built from the same source.

`sable-typegen` hashes the generated TypeScript. It writes the hash to `src/generated/protocol.ts` (`WIRE_SCHEMA`) and to `crates/sable-runtime/schema.hash`, which the runtime compiles in. `mise run check:types` fails if either file is stale.

`App::handshake()` returns `{ schema, slices }`. `checkHandshake` in `src/lib/runtime/handshake.ts` compares it with the UI's build and returns a typed `WireMismatch`: either `schema` or `missing_slices`.

On a mismatch, the shell does not try to keep running:

- Web: reload the page. If the worker is the stale side, restart the worker. A tab loaded before an update reloads.
- Several tabs: one shared worker owns the app, and each tab is a subscriber. The shell maps each `SubId` to its tab, sends a subscription's events to that tab, and sends a reply to the tab that asked. A tab that disagrees with the worker reloads.
- Desktop (Tauri, Electron): the core and the UI ship together, so a mismatch means a broken install. Show the error and offer an update.
- React Native: set Expo's `runtimeVersion` to the native fingerprint, so an over-the-air bundle only loads on a native build of the same Rust core. If a mismatch is still reported, ask for a store update.

`tests/fixtures/wire/forms.json` pins the wire forms: snapshot, patches, replies, notice, resync and handshake. Both the Rust golden test and the TypeScript test read it. Changing a form fails both tests until the fixture is regenerated and the shells are updated:

```sh
SABLE_UPDATE_FIXTURES=1 cargo nextest run -p sable-runtime wire_golden
```

## Panics

On native, a panic in an instance, or in one of its tasks or streams, is caught:

- the instance's requests are lost with `InstanceFailed`,
- its subscribers receive `Resync`,
- on `resync` they attach to a new instance.

An instance that fails three times stays down until the account changes.

On wasm, the release profile aborts on a panic, so the worker stops. The shell restarts the worker, which creates a new `App`. The UI runs the handshake again, rejects its pending requests and resubscribes. Persisted views give it something to show until the core catches up.

## `sable-ffi`

`Ffi` is the surface that shells bind. It takes and returns JSON strings, integer ids, and a flat `FfiError` with a stable `code()`.

Its calls are `handshake`, `subscribe`, `unsubscribe`, `resync`, `range`, `dispatch`, `request`, `query` (pure functions registered by name), `next_batch` and `try_next_batch`, `offer` (for a shell that holds the core in Rust), `switch_account` and `shutdown`.

Every JSON input is decoded with a 1 MiB size limit and a nesting limit. No error repeats the caller's input.

On native, `Ffi::new(app, queries, handle)` takes a tokio runtime handle and runs every call on that runtime. This lets napi threads, Tauri threads, UI threads and any executor call it safely. The runtime's own `spawn` needs a tokio context and panics without one, so these threads must call `Ffi`, not `App`. On wasm, `Ffi::new` takes no handle.

## Testing

`sable_runtime::testing` (feature `testing`, native, current-thread tokio) provides:

- `TestApp`, with a typed fake backend (`expect::<P>().returns`, `.answers`, `.fails`, `.after(&gate)`), a fake platform and a `TestClock` you advance.
- `settle()`, which waits until the app is idle, without sleeping.
- `Gate`, which holds a call back to pin an interleaving.
- `Replica`, which applies events the way a shell does.
- `assert_patches_converge::<S>`, which checks that a replica fed only patches equals a fresh snapshot.

The tests:

- `tests/journeys.rs`: the API through demo slices (patches, requests, timers, streams, persistence, epochs, panics).
- `tests/lifecycle.rs`: races between disposal, account switches and calls, including a four-thread stress test.
- `tests/wire_golden.rs`: the wire fixture.
- `crates/sable-ffi/tests/ffi.rs`: the `Ffi` surface, called from a thread with no runtime.

```sh
cargo nextest run -p sable-runtime --all-features
cargo nextest run -p sable-ffi
```
