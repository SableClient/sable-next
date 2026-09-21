# iOS notifications

`SableNotificationService` links `sable-push` and shares
`group.<bundle identifier>/Sable` with the app, using a separate SDK lock owner.
Decryption checks account/preview policy and times out after 20 seconds. Failure
uses a generic alert, never older plaintext. All alerts follow the sound setting.

## Setup (Apple account required)

1. Register both bundle IDs with one team; enable app Push Notifications and a
   shared App Group.
2. Configure gateway APNs credentials and `pushNotificationDetails.iosPushAppID`.
   Match the signing environment: TestFlight uses production, development uses sandbox.
3. Send generic `aps.alert`, `aps.mutable-content: 1`, the Matrix event,
   recipient `user_id`, and `room_id`. Never send keys or plaintext to the gateway.
   Omit `apns-collapse-id` or use an event-specific value.
4. Install the Rust target matching the Xcode destination. Run `tauri ios init`
   after template changes; the extension build uses the workspace lockfile.

Sign out before switching existing private sessions to shared storage. Without
App Group access or the first unlock after reboot, the extension cannot decrypt.
Missing keys produce generic alerts; the extension does not sync to recover them.

Messages group and clear by recipient/room. Duplicate checks also match event ID;
replacements are silent. Cross-process deduplication is not atomic.

## Verification

- `cargo test -p sable-push`: payloads, account binding and privacy.
- macOS: build simulator/device targets; inspect extension, entitlements and APNs environment.
- iPhone: foreground/background/terminated/locked delivery, missing keys, timeout,
  hidden previews, logout, account switching, token rotation and duplicate alerts.

Swift compilation, signing, memory use and APNs delivery remain unverified on Linux.
