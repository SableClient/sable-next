# iOS notifications

`SableNotificationService` links `sable-push` and shares
`group.<bundle identifier>/Sable` with the app, using a separate SDK lock owner.
Neither process holds a file lock there. Each login's tokens live in their own file
under `login-tokens/`, rewritten by whichever process refreshes them under the SDK's
cross-process refresh lock; only the app writes the account registry.
Decryption checks account/preview policy and times out after 20 seconds. Failure
uses a generic alert, never older plaintext. A push the extension never handles still
reads "New message": `ios/Localization` maps Sygnal's alert keys to generic text.
All alerts follow the sound setting.

Alerts match Android: the room name (or sender) is the title and the body is
`Sender: text`; hidden previews keep the title with a generic body. Messages use the
`sable-message` category (Reply, Mark as read) and are donated as incoming
`INSendMessageIntent`s for communication notifications, with the sender's avatar and,
in group rooms, the room's. An image or video message attaches its thumbnail when
previews are shown and the media preview setting allows it. Both are cached under
`push-media` for a week. Invites read "New Invitation"
with the `sable-invite` category (Accept, Decline). Both categories are declared in
`plugins.notifications.actionTypes`. A push with `counts.unread == 0` closes the
delivered alerts of its room, or of the account when it names no room, if "clear on
read" is on.

## Setup (Apple account required)

1. Register both bundle IDs with one team; enable app Push Notifications and a
   shared App Group. iOS builds use `moe.sable.app` (`src-tauri/tauri.ios.conf.json`),
   so the IDs are `moe.sable.app`, `moe.sable.app.notifications` and
   `moe.sable.app.share`, and the group is `group.moe.sable.app`. Android and
   desktop keep `moe.sable.next`.
2. Configure gateway APNs credentials and `pushNotificationDetails.iosPushAppID`.
   Match the signing environment: TestFlight uses production, development uses sandbox.
   Pushkeys are hex, so a Sygnal app needs `convert_device_token_to_hex: false`;
   otherwise every push fails with `BadDeviceToken`.
3. Send generic `aps.alert`, `aps.mutable-content: 1`, the Matrix event,
   recipient `user_id`, and `room_id`. Never send keys or plaintext to the gateway.
   Omit `apns-collapse-id` or use an event-specific value. Read updates must also
   be alerts (`apns-push-type: alert`); the extension drops them.
   The iOS pusher is always `event_id_only`, so the gateway never sees message text.
   Sygnal then sends no alert, so the pusher's `default_payload` carries a generic one
   and asks for `mutable-content`. The extension fetches
   and decrypts the event as a separate SDK process, beside a running app. It restores
   only the pushed room, with low-memory SQLite settings.
4. Request the restricted `com.apple.developer.usernotifications.filtering`
   entitlement (rings, read updates and pushes the rules silence are dropped with
   empty content) and enable
   Communication Notifications for both App IDs. Without filtering, the system
   shows the generic alert instead. `src-tauri/ios-project.yml` leaves it out until
   Apple grants it: signing fails while the profile lacks a requested entitlement.
5. Calls ring from the extension through `CXProvider.reportNewIncomingVoIPPushPayload`,
   which needs the filtering entitlement; until Apple grants it, a ring is a
   "<caller> is calling" alert. There is no PushKit pusher: the homeserver sends every
   notification to every pusher, and iOS must show each VoIP push as a call. The app
   removes the one older builds registered.
6. Install the Rust target matching the Xcode destination. Run `tauri ios init`
   after template changes; the extension build uses the workspace lockfile.

Sign out before switching existing private sessions to shared storage. Without
App Group access or the first unlock after reboot, the extension cannot decrypt.
Missing keys produce generic alerts. A push whose rules cannot be evaluated is
shown, unless the server pushes every encrypted event (MSC4028).

Logs use the `os_log` subsystem `moe.sable.app.notifications`. With error reporting
on, the app writes `sentry.json` to the shared folder and the extension reports
generic fallbacks to Sentry.
Timeouts log the failed stage and set Sentry's `push.stage` tag. Read-status checks,
activity checks and media downloads stop after three seconds or when one second
remains to deliver the text.

Messages group and clear by recipient/room. Duplicate checks also match event ID;
replacements are silent. Cross-process deduplication is not atomic.

## Verification

- `cargo nextest run -p sable-push`: payloads, account binding and privacy.
- macOS: build simulator/device targets; inspect extension, entitlements and APNs environment.
- iPhone: foreground/background/terminated/locked delivery, missing keys, timeout,
  hidden previews, logout, account switching, token rotation and duplicate alerts.

Swift compilation, signing, memory use and APNs delivery remain unverified on Linux.

## Share extension

`SableShareExtension` copies what another app shares into
`group.<bundle identifier>/Sable/share_inbox`, in the manifest format
`MainActivity.kt` writes on Android, then opens Sable with `<scheme>://share`.
The share sheet suggests the conversations the app donates after each send and
`SableNotificationService` donates for each message received.
