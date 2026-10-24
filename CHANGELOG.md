# Sable Changelog

## 2.2.0 (2026-10-24)

### Features

* Keep other devices quiet while you are using Sable, until you have been away for a chosen time. Receiving a push no longer shows you as online.

### Fixes

* Share audio from selected apps on macOS and from several apps at once on Windows. Keep audio capture from blocking the app.
* Add CSP to web builds and block framing and base URL injection.
* Require separate device permissions for embedded sites and reject unsafe download filenames in Electron.
* Fix crashes when reopening the iOS app after it was in the background.
* Fix MAS device management after legacy SSO login and restore the devices dashboard (#1250).
* Dismiss the mobile keyboard when scrolling the message timeline (#1321).
* Wrap checkable menu option labels to avoid a missing text-node crash (#1341).
* Show push notification content after an app update. Fix profiles, room versions and web push on servers that send both profile capability names. Stop offering Founder as an assignable role.
* Preserve saved sessions after temporary storage and token-refresh failures. Fix Electron crashes during shutdown and when its terminal closes.

## 2.1.6 (2026-10-23)

### Fixes

* Install Binaryen automatically for FOSS Android builds.
* Fix Android incoming calls ignoring silent mode and make background call alerts repeat (#1309).
* Fix the missing unread dot in the Electron Linux tray (#1315).
* Enable PipeWire camera support by default on Linux in the Electron app (#468).
* Fix raw HTML in notifications from Element's rich text editor (#1320).
* Add an optional macOS App Sandbox build with Hardened Runtime (#1306).
* Open Matrix links in Sable, including room joins and direct chats with confirmation. Register the matrix: scheme in native builds and support matrix.to links in Android's supported-link settings.
* Block external images in messages to prevent IP address leaks.
* Wrap room notification option labels to avoid a missing text-node crash (#1319).
* Restore screen-share audio selection on Windows build 20348+: share one app or system audio, excluding Sable (#1316).

* Open iOS registration and account settings in the app. Fix account deletion for OAuth providers such as matrix.org.

## 2.1.5 (2026-10-22)

### Fixes

* Added reply button in the reactions view
* Clear deafen state when a call ends so the next call uses the lobby microphone setting.
* Fix long messages extending under the composer's expand button on iOS.
* Keep a custom profile name colour legible on a tinted profile card in the dark theme.
* Update desktop and web dependencies and fix certificate trust vulnerabilities.
* Allow dots in sticker and emote shortcodes.
* Update the emoji picker to Emoji 18 with refreshed labels and shortcodes.
* Fix Flatpak startup by extracting the app to the correct directory.
* Add a toggle to omit original event metadata when forwarding a message. Existing forwards retain their metadata as required by MSC4553.
* Keep custom emoji as images when placed inside inline code in plain-text mode.
* Keep role tag colours legible on every theme, whatever the name colour correction is set to.
* Fix the login Tab order so the password field comes before the forgot-password link.
* Use the selected per-message profile for polls, locations, galleries, reactions, gestures, bot commands, forwards, scheduled messages, and notification replies.
* Open the native file dialog for profile pictures, banners, avatars and emoji uploads in the desktop and mobile apps.
* Give every incoming message its own alert on desktop and web push instead of replacing a room's notification.
* Keep inline code hidden inside spoilers when composing and editing messages.
* Remember the desktop window's size, position, maximized and full screen state across restarts.

## 2.1.4 (2026-10-21)

### Fixes

* Allow messages with a file, video or audio attachment to be edited, by editing their caption.
* Open the native file dialog for attachments and exports in the Electron app, rather than the browser's.
* Fixed launch crash on Windows.
* Install the Linux app as `sable` again, so the deb, the rpm and the AUR packages put `/usr/bin/sable` back in `PATH`.
* Add Windows tray support.

## 2.1.3 (2026-10-21)

### Fixes

* Allow messages with a file, video or audio attachment to be edited, by editing their caption.
* Open the native file dialog for attachments and exports in the Electron app, rather than the browser's.
* Install the Linux app as `sable` again, so the deb, the rpm and the AUR packages put `/usr/bin/sable` back in `PATH`.

## 2.1.2 (2026-10-21)

### Fixes

* Fixed launch crash on Windows.
* Add Windows tray support.

## 2.1.1 (2026-10-21)

### Fixes

* Fix Electron and Android release builds.

## 2.1.0 (2026-10-21)

### Features

* Added a badge next to settings that aren't synchronized across devices
* Ship the desktop apps on Electron for Windows, macOS and Linux, importing the Tauri app's settings on first launch.

### Fixes

* Lower CPU and memory use in large encrypted rooms when room keys arrive.
* Fix extra colons in custom emoji alt text and titles.
* Keep popup background present while scrolling content fades.
* Keep Markdown literal in incoming messages and previews.
* Ring for one-to-one calls on Android when the app is closed.
* Use the server's mutual rooms endpoint instead of checking locally cached membership.

* Recover sync after the computer sleeps

## 2.0.3 (2026-10-17)

### Fixes

* Publish the Electron build as a Flatpak and to the deb and rpm registries.
* Fix sign-in focus, hide Next until the provider is validated, and announce authentication loading and errors.
* Add Ctrl/Cmd+E, Ctrl/Cmd+G and Ctrl/Cmd+S shortcuts to toggle the emoji, GIF and sticker pickers. Inline code moves to Ctrl/Cmd+Shift+C.
* Fix color inconsistency in timeline for senders when no custom name color is set.
* Fix Electron Linux packages and publish update manifests to Forgejo.
* Fixed profiles not being consistent between default and custom colors.
* Follow the system light or dark mode live on the Linux desktop app
* Add Default, System, and Custom font choices in Appearance. Fix theme overrides hiding font selections and monospaced font settings resetting after restart.
* Made monospace font consistent and added code ligatures to inline and block code, as well as file previews
* Ask an older tab to reload when a newer Sable opens, instead of both writing to local storage
* Option to pin PMP picker to left side of composer
* Room header actions are a keyboard toolbar, and settings pass accessibility checks
* Include custom settings panels in search and show their setting names in shared links.
* Sign-in and setup are quieter for screen readers
* Stop counting thread messages in a room's unread badge

* Add new UI sounds & ringtone

* Add a Nix flake

* Added new audio player design

* Keep usernames at top of the message in compact layout

* Pause sync while the web app is hidden

* Remove message groups from Compact layout

* Show avatars in message headers in Compact layout

## 2.0.2 (2026-10-11)

### Fixes

* Add pronoun extraction to PluralKit imports
* Add DeArrow support for YouTube embeds

## 2.0.1 (2026-10-11)

### Features

- Add a confirmed option to delete all per-message profiles.

### Fixes

- Allow fullscreen video playback on Android.
- Keep the sidebar's current room list when opening Create Room.
- Bring back the body field in the emoji and sticker pack editor.
- Fill the invite field from a suggestion instead of inviting straight away.
- Collapse the mobile alert slot when no alerts remain.
- Centre the selected mobile toolbar item on its icon.
- Stop pasting copied text from adding a newline before it.
- Stop flooding the homeserver with presence updates.
- Allow saving a status without an emoji.
- Keep the unread position when the timeline resumes after a while in the background.

## 1.22.9 (2026-09-26)

### Notes

- The last Sable v1 release. Sable v2 continues from here.
