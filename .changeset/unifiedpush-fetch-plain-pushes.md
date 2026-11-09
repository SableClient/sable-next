---
default: patch
---

On Android, UnifiedPush through a Matrix gateway only sends event ids, so the push server no longer sees message content and a forged push cannot show made-up text.
