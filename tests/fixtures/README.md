# Migration crypto fixture

`v1-crypto-18.4.json` contains synthetic test secrets generated using the actual
`@matrix-org/matrix-sdk-crypto-wasm` 18.4.0 package installed in `../Sable`.
It was generated in a fresh headless Chromium context on an isolated temporary
localhost origin. No Sable app profile, credentials or storage was used.
The runtime reports wasm revision `16a138b`, SDK crypto 0.18.0, and vodozemac
0.10.0; the upstream wasm tag's lockfile pins Rust SDK `fd95d90`.

Generation used `OlmMachine.initialize` for `@migration:example.org`/`V1DEVICE`
and a synthetic peer. `bootstrapCrossSigning(false)` creates private and public
cross-signing data. Synthetic `KeysUpload`, `KeysQuery` and `KeysClaim` responses
exchange signed device/one-time keys through `outgoingRequests`,
`getMissingSessions` and `markRequestAsSent`. The peer is locally verified with
`Device.setLocalTrust(Verified)`.

The peer's `shareRoomKey` request is delivered through `receiveSyncChanges` to
create inbound Olm state and a replay hash. The exporting machine creates its
own room key with `shareRoomKey`, encrypts a known message with
`encryptRoomEvent`, and successfully decrypts it with `decryptRoomEvent` before
export. Room settings, pending/downloaded room-key metadata and a backup key
are persisted through their public SDK APIs.

After closing both machines, the generator reads every schema-107 crypto object
store with a readonly cursor and preserves raw keys/values, key paths, auto-increment
flags and indexes in `database.stores`.
The envelope additionally supplies expected identity keys, room ID, plaintext
and the encrypted event. Binary JS values are represented as JSON arrays.

This fixture includes account, cross-signing, trusted devices, two Olm sessions,
two inbound Megolm sessions, an outbound Megolm session, replay hash, backup
key/version, tracked user and room metadata. Gossip requests, secrets inbox,
withheld keys, received bundles and lease locks are empty; tests for those
classes need separate fixtures. It represents fresh v1 SDK state, not every
historical v1 schema or a physical native-app upgrade.

Regenerate with `node tests/fixtures/generate-v1-crypto.mjs`, from the repository
root, with v1 dependencies installed in `../Sable`. An explicit path to the
wasm package can be supplied as the first argument. The generator uses a fresh
browser context and creates new random synthetic identities on each run.
