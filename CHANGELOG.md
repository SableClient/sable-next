# Sable Changelog

## 2.3.1 (2026-11-02)

### Fixes

* Make the FOSS Android APK reproducible again.

## 2.3.0 (2026-11-01)

### Features

* Add a Push rules section to the developer settings to turn rules on or off, edit their actions and delete custom ones. The account data editor now shows `m.push_rules` as read-only, since the homeserver manages it.
* Pick your own ntfy server for the built-in Android notification connection in Settings → Notifications.
* Encrypt the local message and key stores with a key from the system keyring. Existing stores are encrypted on the first start without signing in again, and the room list is fetched again once. Notification previews show a generic alert until the app has been opened after the update.
* Send spoilered images and videos as part of a gallery instead of splitting them into separate messages.
* The Linux desktop app can be installed with Nix from the flake as `sable-desktop`.
* Send and show rich room topics (MSC3765). Plain topics are no longer read as markdown (#1398).
* Seal saved logins with a key kept in the system keyring, the Android Keystore or the iOS Keychain. On a desktop without a usable keyring, such as Linux with no Secret Service, the key is kept in a file only you can read instead.
* Search finds messages with small typos, so searching delegate also finds deligate (#1420).
* On desktop, themes and tweaks imported from a file reload when the file changes (#1440).
* Accept ISO 8601 dates in `$[unixtime …]`, like `$[unixtime 2026-11-01T14:30+01:00]` (#1070).

### Fixes

* Settings › About shows the folder the desktop app keeps its data in (#1302).
* Add a setting to show the time on every message, including grouped ones (#1434).
* Fix linking a new device from Android failing while the approval page is open.
* Keep the tall composer layout while the Android keyboard is open (#1460).
* Keep saving images on Android once many share the same name (#1441).
* Shared audio files have a volume control that remembers its level (#1432).
* Say that you are banned, with the reason given, when joining a room you were banned from (#1458).
* Stop embedding a bridged video or image a second time from the link in its caption.
* Stop the app from freezing when rejoining a call with incoming voice isolation on, and play a voice at its own volume when its audio element was last used for a screen share.
* Fix someone in a call staying silent until you rejoin.
* End the call when you sign out or switch accounts, close the screen sound picker when a call ends, and stop device errors from a finished call showing up afterwards.
* Close the open chat from the room menu or with Alt+W (#1433).
* The Replaced rooms list in the sidebar can be collapsed (#1281).
* Desktop sign-in opens your browser and returns to Sable through a local loopback redirect, so SSO no longer lands in another app or a second Sable window (#1312).
* Add open at sign-in, start hidden, native unread badges, taskbar flashing and zoom shortcuts to the desktop app.
* Stop the draft sync setting from claiming drafts are always unencrypted (#1486).
* Stop writing per-room push rules for direct chats and remove the ones already on the account, so notifications follow the standard two-member rule like other Matrix clients.
* Keep Linux screen share audio out of the mic when EasyEffects is running (#1447).
* Fix screen share audio and device lists hanging in the Linux Flatpak when camera access was denied (#1491).
* Show a forum topic's title at the top of the topic instead of its first message (#1476).
* Default screen sharing to H.264 and enable hardware video encoding and decoding in the desktop app.
* Open Home on launch when it is enabled in the sidebar (#1488).
* Add a Threads filter to the inbox, mark thread replies, and count a reply as read once you read its thread (#1451).
* Play the notification sound on iOS for messages that ask for one (#1443).
* Fix joining big spaces by alias failing with a URL too long error.
* Click the message shown above the composer while replying or editing to jump back to it (#1246).
* Keep GIF thumbnails on video link previews still when GIF autoplay is off (#1493).
* Include core log lines and event details in debug log exports from the Android and iOS apps, and send Android core logs to logcat.
* Keep the encryption store out of Android and iOS backups, as restoring one broke decryption. You now sign in again after a restore.
* Bind numpad keys separately from the main keyboard row (#1426).
* Keep the Apply bar of your own emoji packs in view while you edit them (#1464).
* The profile picker shows your account name and avatar instead of "No profile" (#1116).
* Keep the persona name, pronouns and account name from leaving a gap or running into the timestamp on narrow screens (#1461, #1462).
* Settings › Per-message profiles can be searched (#1487).
* Add direct messages to spaces privately. Only you see the link, no space admin rights are needed, and the chat uses the space's emoji and abbreviations (#1384).
* Disable the profile change propagation setting on homeservers without MSC4466, which apply name and avatar changes to every room (#1425).
* Open device approval on Android as a sheet over Sable, so it closes on its own once the new device is linked.
* Fix the login screen staying up after signing in with a QR code.
* Drop the automatic migration from Sable v1, so v1 accounts now sign in again.
* Make the FOSS Android APK reproducible again.
* The forward and add-existing-room dialogs show each room's published address, so rooms with the same name can be told apart (#1287).
* Choose whether a room loads media for you from its appearance settings, synced with other clients through MSC4278 (#1346).
* Seal the saved web session with a browser key that page scripts cannot export. The browser keeps that key in its profile, so the web app still relies on the device being protected. Safari cannot keep such a key in the background worker, so there the session stays unsealed.
* Keep keys in files instead of the system keyring with `--password-store=basic` or `SABLE_SECRET_STORE=files`. Logins saved in the keyring need signing in again.
* Stop hidden pronoun pills from cutting a few pixels off a sender name that just fits.
* Stop a sent message from coming back as a draft when the app is closed right after sending (#638).
* List new settings and changed defaults on the home page (#1478).
* Keep the short composer on one row on narrow phones until the text wraps.
* Show unjoined subspaces in the space lobby so they can be joined (#1211).
* Publish a GPG-signed `SHA256SUMS` file with every release.
* Add a setting to hide the count on reactions only one person sent (#1471).
* Add a setting to open the member list when swiping left on a message, as in Sable 1 (#1437).
* Load the original image when a thumbnail would not help or the homeserver cannot serve one, so images stop failing on servers without thumbnails.
* Keep tooltips, menus and popovers from opening behind the custom title bar.
* Device verification opens the camera only when you choose to scan (#1356).
* Use a reverse-domain Wayland app id on Linux, `moe.sable.client` and `moe.sable.next.electron.Nightly` for nightly (#1453). Launchers pinned to the old entry need pinning again.
* Fix the desktop app looking overbright on SDR monitors on Windows when an HDR monitor is connected (#1367).

* Account settings layout adjustment

* Emoteboard custom emotes layout adjustment

## 2.2.3 (2026-10-30)

### Fixes

* Fix Android SSO and QR approval pages not opening. Show an error if a QR approval page cannot be opened.
* Use popups for OAuth and QR login on desktop and web, and in-app browsers on mobile. Add automatic closure and a desktop browser fallback.
* Open profile avatars and banners in the media viewer throughout the app.
* Notify room members about calls on homeservers without sticky events.
* Open the existing DM when a chat link is opened during startup.
* Stop overwriting downloads with the same name in the desktop app.
* Turn off emoticon-to-emoji conversion by default; it stays available in Composer settings.
* Update Flatpak builds to the Freedesktop 26.08 runtime and use its desktop-file-utils.
* Make the FOSS Android APK reproducible regardless of the build directory.
* Fix the Android keyboard closing when swipe-deleting text up to a mention in the composer.
* Ring incoming calls on iOS when the App Store region is unknown.
* Fix the iOS app crashing when a page reloads while it is still waiting for an answer from the app.
* An alternate avatar picked in the persona picker is no longer reset when you send a message, including messages using a persona shorthand.
* Adding a second account no longer wipes your installed and selected themes.
* Fix Android and iOS crash and error reports never reaching Sentry. Report undecryptable messages from the Android and iOS apps.
* Starting a verification from a dialog no longer cancels it or sends you back out of the settings section.
* Keep per-message profiles that share an ID or a PluralKit name instead of deleting one on the next save.
* Fix the message field shrinking to a single row between the buttons when the keyboard opens on some Android phones.
* Start QR camera previews sooner and allow retrying failed camera startup.
* Fix reaction history tracking, rank by usage over 30 days, and remove expired or duplicate entries. Move history and picker selection rules into Rust.
* Stop saving text reactions in reaction history and remove ones already saved.
* Show rooms removed from a space in the rooms without a space.
* A private room that is not a direct message no longer shows the invited person's avatar as its icon.
* Fix missing incoming call notifications and ringing across web, desktop, Android, and iOS.
* Fix server-mode sign-outs on startup errors and revoke disabled users right away.
* Keep spoiler images and videos hidden while uploading.
* Place timeline day dividers by the time zone chosen in settings.
* Fix YouTube embeds failing with error 153 in the desktop app.

* Room topics now show spoilers, tables and math the way messages do, and bare links in them stay clickable.

## 2.2.2 (2026-10-29)

### Fixes

* Reload the account avatar after returning from a long background session.
* Support Java 25 for Android builds.
* Fix Android crashing on launch after updating to 2.2.1.
* Build unsigned Android release APKs when no keystore is configured.
* Fix conflicting device verification badges and stale verification warnings.
* Convert emoticons such as `<3` and `:)` to emoji by default, with a Composer setting to turn it off.
* Support iOS 15.4.
* Fix blank screen shares in fullscreen on iOS.
* Keep removed link previews hidden when editing a message.
* Keep reply mentions when editing messages.
* Support bundled link previews with encrypted thumbnails and preserve preview choices when editing messages.
* Open device approval inside Sable on Android and iOS. Give background sync a three-second grace period and discard outdated pause requests.
* Use `Sable/<version>` as the User-Agent for native and Electron HTTP requests.
* Fix room icons, profile pictures, and chat images failing to load in server mode.
* Fix thread loading, links to replies, and thread actions. Keep reply counts, previews, forum activity order, and unread status up to date.

## 2.2.1 (2026-10-28)

### Fixes

* Fix Electron notification clicks and keep room messages visible when a notification's message is unavailable.
* Keep Chromium locale files needed for video menu labels on Linux and Windows.
* Fall back to the user ID when a display name has no visible text.
* Move donator badge styling to account settings
* When your homeserver sends pushes itself, as Continuwuity does, the notification troubleshooter now checks the push service and sends a test push.
* Alerts now clear when their rooms are read on another device.
* Only another Sable device in use keeps notifications quiet; other Matrix apps, bots and bridges being online no longer silence them.
* Add a self-hosted server mode with persistent Matrix stores and Docker deployment.
* Slightly change context menu layout, spacing and truncating.
* The notification troubleshooter says when the push gateway could not pass the test push on to your push service.

## 2.2.0 (2026-10-26)

### Features

* Keep other devices quiet while you are using Sable, until you have been away for a chosen time. Receiving a push no longer shows you as online.
* Add an option to remember approved widget permissions.

### Fixes

* Keep persona changes synchronized across devices without overwriting newer edits (#1393).
* Fix the account page showing another account's saved status message.
* Fix background Android calls with hidden previews (#1309).
* Copy images to the Android clipboard (#1167).
* Stop Android alerts for filtered notifications (#872).
* Fix Android notifications ignoring nicknames and showing invisible names.
* Share audio from selected apps on macOS and from several apps at once on Windows. Keep audio capture from blocking the app.
* Fix faded edges on the active sign-in card on narrow screens.
* Show bookmark previews on the first visit (#1027).
* Fix bridge bot notices showing part of their text as the sender name (#1374).
* Fix calls ending after a short network loss instead of reconnecting.
* Download the Chinese search dictionary on demand on desktop and web too, keeping it out of the app bundle.
* Fix Chinese message search and download its dictionary on demand on Android and iOS.
* Clarify bulk emoji pack subscriptions (#1329).
* Fix right-click showing no edit menu in desktop text fields.
* Add CSP to web builds and block framing and base URL injection.
* Restore desktop image sharing actions (#1272).
* Require separate device permissions for embedded sites and reject unsafe download filenames in Electron.
* Fix controls overlapping the system status area on iPhone Duo.
* Fix long emoji shortcodes overflowing the picker preview.
* Fix Explore and voice control alignment (#1296).
* Speed up touchpad pinch zoom (#1347).
* Add Ukraine, Palestine, and Cuba app icons and donor badges.
* Keep bold, italic, strikethrough and links on text that contains inline code.
* Improve user profile card elements and style.
* Let the sign-in and setup pages scroll on iOS.
* Fix iOS alerts for encrypted messages excluded by notification rules.
* Fix iOS notifications ignoring custom nicknames.
* Fix crashes when reopening the iOS app after it was in the background.
* Fix rooms missing from spaces after the iOS app returns from a long time in the background.
* Fix saving emote and sticker packs whose shortcodes were made by other clients.
* Keep long subspace names from widening the space lobby on phones.
* Fix composer formatting shortcuts in Markdown mode (#1366).
* Fix MAS device management after legacy SSO login and restore the devices dashboard (#1250).
* Fix accounts migrated from Sable v1 taking a long time or failing to load on a slow connection.
* Save mobile images with one tap (#1139).
* Dismiss the mobile keyboard when scrolling the message timeline (#1321).
* Fix switching spaces on mobile to restore the last visited room.
* Keep oversized messages in the composer with an error (#1334).
* Sign in to homeservers that enable Sliding Sync per user instead of reporting it as unsupported.
* Keep phones compact in landscape (#1215).
* Fix the desktop window exceeding the available screen area on Phosh and other small displays.
* Keep saved personas when the catalog reloads (#1136).
* Keep rooms and subspaces visible when the local space child list is incomplete (#1211).
* Keep your sidebar space order when returning to the iOS app (#1391).
* Fix quoting selected lines and toggling quotes with a trailing empty paragraph (#1365).
* Fix rooms opened at the latest message staying unread.
* Make the FOSS Android APK reproducible from the release tag, and ship it without Sentry.
* respect 24 hour format in profile cards
* Restore the room title after closing settings (#1333).
* Wrap checkable menu option labels to avoid a missing text-node crash (#1341).
* Fix dropdown control alignment with text fields and spacing around wrapped options.
* Show push notification content after an app update. Fix profiles, room versions and web push on servers that send both profile capability names. Stop offering Founder as an assignable role.
* Preserve saved sessions after temporary storage and token-refresh failures. Fix Electron crashes during shutdown and when its terminal closes.
* Fix sidebar items bouncing when hovered near their edges.
* Bring back the sidebar hover nudge without the bounce near item edges (#1282).
* Sign the RPM packages so dnf can install them from the package registry (#1311).
* Fix returning to the default light and dark themes with settings sync enabled.
* Close tombstoned rooms without a replacement (#1161).
* Offer a download when a video can't be played on this device instead of showing a blank player.
* Fix missing thumbnails when sending videos individually or in galleries.
* View room images and your own profile images at full size (#1377).
* Fix invisible display names showing instead of the user ID.
* Keep all composer formatting controls reachable on narrow desktop displays (#1209).
* Fix YouTube embeds failing with error 153 in the desktop apps.

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
