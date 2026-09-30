`matrix-sdk` 0.19.1, revision `bc2502ee3d3ba1dc687740df5be0f8635032399e`.
Licensed under Apache-2.0; see `LICENSE`.

The manifest resolves upstream workspace dependencies explicitly. Other SDK
crates use the same git revision. Upstream development dependencies and
integration tests are omitted; the `testing` feature is retained.

[`sable-backup.patch`](sable-backup.patch) contains the runtime changes:

- Backup status reports local and cloud counts and checks whether recovery is unlocked.
- Manual restore checks the backup version and key, then imports batches of
  100 keys through the existing SDK path, reporting progress.

The bulk endpoint is not paginated, so download progress is indeterminate until
the response arrives. Keys stay in Rust; the UI receives counts.

On SDK upgrades, replace the upstream source, resolve the manifest, reapply the
patch, and update all SDK revision pins. Run `room_keys::tests` in `sable-core`
and the WebAssembly check. Remove this override when upstream provides these APIs.
