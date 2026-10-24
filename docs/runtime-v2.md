# App runtime

## Crates and data path

Only `sable-core` uses the Matrix SDK. `sable-model` holds pure rules;
`sable-protocol` holds RPC and wire types. `sable-runtime` runs slices without
knowing their domains. `sable-ffi` exposes the app to `sable-wasm`, `sable-node`
and Tauri.

The UI sends actions through `src/lib/runtime`. A slice reduces an action
synchronously, edits its view and returns commands. Commands call the core or
platform; their results return as inputs. Core events also become inputs.
The runtime publishes patches before replies from the same batch. A shell
applies the whole batch before rendering.

`Doc` publishes changed top-level fields. `ListDoc` publishes typed
`VectorDiff`s for its `items` field and a top-level `total`, restricted to each
subscriber's window. `None` selects the whole list. Backpressure sends
`Resync`; the client must fetch a snapshot before applying more patches.

Timelines live in `crates/sable-slices/src/timeline`. The slice filters and groups
rows, tracks unread state and owns pagination. Windowed subscribers also receive
the full event list for media, editing, receipts and navigation. Threads and forums
derive their items from rows. Lists use patches. The local unread boundary remains
separate from the SDK marker: the SDK marker cannot move backwards and follows
shared read state.

## Adding a slice

Implement `Slice`: key, state, view, action, input,
`init`, `view`, and `reduce`. Choose `Singleton` or `RefCounted { grace }`.
Use `INTEREST`, `core_input` and `event_key` to route core events. Release core
subscriptions in `dispose`. Disposal awaits its commands before stop returns.

Register the slice in the app registry. Register view and action types in
`sable-typegen`. Add reducer tests, a patch convergence test and a `TestApp`
journey. The UI keeps rendering and platform interactions; domain rules live
in the slice.

Native instance panics lose pending requests with `InstanceStopped` and remove
the instance. A later call starts it again. Wasm panics abort the worker; the
client rejects pending requests, reconnects and resubscribes.

## Persistence, accounts and tabs

`PERSIST` passes the saved view to `init`. Changed views save after two seconds,
on flush and on disposal. Writes run in order. Keys include account, slice and
instance key. A different `WIRE_SCHEMA`, invalid view or view over 1 MiB is
ignored. Keep durable user preferences outside these snapshots.

`switch_account` advances the epoch, stops old instances, loses their requests
and asks subscribers to resync. Old patches and notices are dropped. Results of
previously running commands are discarded; their core calls may still finish.
Shutdown suspends new instances until `switch_account` resumes them. Shells
stop the runtime before changing the core account. On native, call `Ffi`
using its tokio handle when outside a tokio runtime.

The UI and runtime must share a schema. `sable-typegen` writes the TypeScript
and `crates/sable-runtime/schema.hash`. A mismatch requires a web reload or a
native update. The wire fixture is `tests/fixtures/wire/forms.json`.

`AccountGate` orders runtime calls and account changes in all shells. Runtime
calls hold a read lock. Account changes suspend and drain the runtime before
taking the write lock and changing the core account; `switch_account` resumes
it before releasing the lock. Restore of the account already served uses
`active_session` under a read lock.

`Tabs` maps subscriptions and requests to their window. Web uses a SharedWorker,
Electron a utility process and Tauri the app process. On a restart the client
rejects requests and resubscribes. MessagePort runtime calls use Comlink. Web
snapshots use IndexedDB through idb; native shells use account-specific files.
Flush before cache reset, takeover or normal exit.

## Testing

Use `testing::TestApp` on a current-thread tokio runtime. `Gate` pins an
interleaving; `settle` waits for runnable work and `advance` moves paused time.
`Replica` and `assert_patches_converge` check snapshots against patches.

```sh
CARGO_INCREMENTAL=0 cargo fmt --all -- --check
CARGO_INCREMENTAL=0 cargo clippy --locked -p sable-runtime -p sable-ffi --all-targets --all-features -- -D warnings
CARGO_INCREMENTAL=0 cargo nextest run --locked -p sable-runtime -p sable-ffi --all-features
CARGO_INCREMENTAL=0 cargo run --locked -p sable-typegen -- --check
pnpm exec vitest run src/lib/runtime
pnpm lint
pnpm check
pnpm test:runtime
```
