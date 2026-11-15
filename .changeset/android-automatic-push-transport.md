---
default: patch
---

On Android, choosing Automatic or Native push after having used the built-in WebSocket transport now switches back to native push when it is available, so background notifications arrive again. The F-Droid build can also use Native (FCM) push on devices with microG or Google Play services. The notification troubleshooter warns when the built-in connection is selected on a phone where native push works and explains how to switch.
