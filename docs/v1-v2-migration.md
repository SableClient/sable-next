# v1 to v2 migration

Migration runs before account restoration on web and Tauri. It preserves user
and device IDs, tokens, OAuth client registration, encryption keys and supported
settings. Existing v2 accounts and settings take precedence.

Web copies v1's crypto IndexedDB databases into v2 account stores. Tauri imports
schema-107 IndexedDB records into SQLite, or backs up an older native SQLite
store before opening it with the current SDK. Both paths publish credentials
only after the crypto stores pass validation. Failed imports can retry. The
source stays intact, and a completion marker prevents reimport after logout.

Local `settings` and server `moe.sable.app.settings` are converted into v2
preferences. Supported favorite GIFs, including old Klipy proxy URLs, are read
from `moe.sable.favorite_gifs`. Unsupported values stay in the v1 source. Server
history syncs again; v1 composer drafts were not persisted.

The frontend code is in [src/lib/migrations/v1](../src/lib/migrations/v1).
Native import code is in [v1_migration.rs](../crates/sable-core/src/v1_migration.rs),
with [Tauri commands](../src-tauri/src/v1_migration.rs).

## Removal

Set `V1_MIGRATION_ENABLED = false` in
[config.ts](../src/lib/migrations/v1/config.ts) to stop migration on web and
Tauri. This also disables the old local settings and server-event fallbacks.
There is no automatic expiry. Users who skip the supported upgrade window need
a migration-enabled release to preserve their v1 device.

Migrated accounts use normal v2 stores. To remove the importer afterward:

1. Delete `src/lib/migrations/v1/`. Remove its imports and calls from both
   transports, `preferences.svelte.ts`, `sync-documents.ts` and
   `core/client.svelte.ts`. Remove `migrationFailed` and its error-UI branch,
   translation and test.
2. Remove `V1_MIGRATION_KEY` and the three migration helpers from
   `platform/session-storage.ts`. Keep the session database and crypto stores;
   unused completion markers are harmless.
3. Delete the native `v1_migration.rs` modules and `v1_migration_tests.rs`.
   Remove their module declarations, the Core field/initializer, four Tauri
   command registrations, and sable-core's direct `rusqlite` dependency.
   Regenerate the lockfile. The SDK still needs SQLite.
4. Delete `playwright.migration.config.ts`, `tests/e2e/v1-migration.spec.ts` and
   the migration fixtures. Remove `AccountSync.legacy` and its test if it has
   no remaining callers.

Keep OAuth issuer persistence/validation, production app identity and accepted
OAuth redirect schemes. Already migrated accounts still use them. Run the
frontend/native checks and verify restoration of a migrated account after
removing the importer.

## Verification

The fixture uses v1's actual wasm 18.4.0 runtime with synthetic identities.
[Fixture notes](../tests/fixtures/README.md) describe its contents and limits.

Browser tests cover Chromium, Firefox, WebKit and mobile browser emulation:
copying records and indexes, interrupted writes/retry, occupied destinations,
missing keys, large batches, logout, and restoration with the actual v2 WASM
runtime. Native tests check preserved identity keys, old/new message decryption,
trust, sessions, secrets, incomplete imports, OAuth issuer checks and SQLite WAL
backup. The SQLite test uses a current SDK store, not an installed v1 schema-15
store. Browser emulation does not test native app upgrades.

```sh
pnpm test src/lib/migrations/v1
pnpm exec playwright test -c playwright.migration.config.ts
cargo test --locked -p sable-core v1_migration
pnpm check
cargo check --locked -p app --lib
cargo check --locked -p sable-wasm --target wasm32-unknown-unknown
```

Before release, test signed installed upgrades on supported platforms, a real
v1 SQLite store, and OAuth refresh against a real provider. Encrypted historical
stores require their original passphrase; unsupported stores fail without
publishing an account. Close v1 windows before upgrading so both versions cannot
rotate the same refresh token. Retained data alone does not make rollback work
with rotated tokens.

## Release configuration

Stable builds run [prepare-v1-release.mjs](../scripts/ci/prepare-v1-release.mjs)
to use v1's `moe.sable.client` identity. Development/nightly builds stay separate.
Keep the original signing identity, a newer version number and the web origin.
If the identity helper is removed, retain the production identity in the release
configuration.

Stable Linux builds keep WebKit because CEF cannot read v1's WebKit profile.
Changing runtimes needs a separate profile migration.

V1 and v2 have different updater keys and default channels. Automatic delivery
needs a v2 bundle signed for v1's verifier on its old channel, or a v1 bridge
release that changes the key/channel first. This data migration does not change
signing secrets or published channels.
