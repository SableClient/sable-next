# Session lifecycle in sable-core

How the core changes which account is signed in without deadlocks or cross-account mix-ups.

## Lifecycle changes go through one queue

Restore, switch, sign-in, logout, removal, cache reset, app activity, sync restarts and push client
loans run one at a time on the queue in `supervisor.rs` (`Core::supervise`, `Core::supervise_later`).

- A job gets a `Supervised<'job>` proof, and lifecycle steps take `&Supervised`: ending a session
  (`take_session`), retiring a login (`mark_account_needs_reauth`), removing an account
  (`remove_account`, `retire_account`) and opening a saved account (`saved_account_client`). The
  proof cannot outlive its job, so it cannot reach a spawned task.
- Code outside a job queues one: sign-in flows use `require_sign_in` and `release_account_client`,
  and a new session retires the accounts it replaced one job each (`retire_replaced`).
- A job never waits for another job. `supervise` called from inside a job returns `Unavailable` and
  fails a debug assertion. On the web the job is marked while it is polled.
- A job calls the network only with a timeout, and only for a step that must happen in order with
  the change (hanging up calls before the token is revoked, presence before suspension).
- Logout and removal are two short jobs so the server sign-out happens between them: the first ends
  the session and retires the account, so no restore picks it up, and the second removes the files.
  The second is refused once a sign-in uses the account again (`remove_retired`). The wait for a
  push is done before the first job and checked again inside it.
- A job past `JOB_DEADLINE` is cancelled, so the changes queued behind it run. A store upgrading
  itself is exempt (`Supervisor::unbounded_step`). After every job `recover_after_job` ends whatever
  session a cancelled job left unfinished and tells the app, and a cancelled job's registry is read
  again from what was saved.
- Jobs don't catch panics: release builds and the web abort on panic.

## An operation takes its session once

`core.signed_in()?` returns a `SignedIn`: the client, sync service and caches of one session. Use it
for the whole operation, even across an account switch.

- Reading or writing the session slot directly (`SessionSlot::current`, `SessionSlot::write`) is
  denied in `.clippy.toml`, except at the lifecycle sites that carry an
  `#[expect(clippy::disallowed_methods)]`. Tests use `test_support::set_session`.
- `SignedIn` does not deref to `Core`. Core-wide state is reached with `.core()`.
- An operation gates its events with `SignedIn::generation()`, not `Lifecycle::current()`, which
  is another session's once the user switched.
- `signed_in()` refuses a session that is being torn down.

## Where state lives

- `SessionState` (`lib.rs`): everything one session caches, its tasks, inbox, calls, search crawl and
  peers, and the locks that serialize its account-data writes. It ends with the session.
- `Settings` (`settings.rs`): what the app configured, kept across sessions.
- `SignInFlows` (`auth.rs`): sign-ins under way, before any of them is a session.
- `Core`: what spans accounts, the registry, the account clients lent to pushes, activity. The
  account lock in `Activity` is keyed by the session's generation, so it ends with it.

## RPC methods

Signed-in methods implement `SessionHandler` (`api/mod.rs`). They run to completion on the session
they started with, so a switch never cuts their server writes in half. Only a logout stops them
(`until_discarded`), since its token is revoked.

- Long reads set `ENDS_WITH_SESSION`, which stops them with `NotLoggedIn` when their session ends.
  Methods that write to the server don't.
- A method that must work signed out stays a plain `Handler` and calls `core.signed_in()` itself.

## Ending a session

`take_session` cancels the session's `ended` token first, hangs up its calls, clears its handlers,
stops its tasks and waits for them to be gone (`tasks::stop_all`), saves its inbox, then clears its
caches.

- Logout and cache reset remove a store only if the sync stopped (`sync_support::stop`) and the
  session quiesced (`SessionState::quiesced`: its tasks are gone and the RPC methods on it finished,
  `SignedIn::begin_operation`). Otherwise they fail and leave the files.
- A method that waits for the queue does so with `until_ended`, so the job ending its session never
  waits for it in turn.
- A cache write checks `has_ended()` under the cache's own lock, so nothing lands in a cleared cache.
- Background work goes through `track_session_task`, which refuses tasks once the session ended.
- Client event handlers capture a `WeakSignedIn`, which stops resolving when its session ends.

## Pushes

Every push that uses a client the app holds counts a loan (`AccountClients::lend`, `count_loan`), the
active session's client included. Loans are taken only inside a job. Anything that closes or removes
a store waits for the loans first (`wait_for_lent_client`, 30 s at most), in the same job, so no loan
starts between the wait and the removal.

## Locks

- `parking_lot` for short synchronous sections, `tokio::sync::Mutex` where the guard is held across
  `.await` or the section is slow (`Inbox::cache`). `SignInFlows::pending_login` and
  `SessionState::calls` are `tokio` because their guard is dropped just before an await, which
  `await_holding_lock` cannot see.
- `Mutex<()>` serializes work that must not overlap: a read-modify-write of server data, one fetch
  at a time, or one user of a store.
- Test builds abort with backtraces when `parking_lot` locks deadlock
  (`test_support::watch_for_deadlocks`). Async lock cycles are covered by `lifecycle_tests.rs`.
