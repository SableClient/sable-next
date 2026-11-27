---
default: patch
---

Sable wakes less while idle or in the background: it no longer scans every joined room for call invitations each second, fetches TURN servers for search sharing every minute, checks the search index size, wakes every 30 seconds with the search crawler off, probes the server while the system reports a working network, wakes its sync watchers while paused or restarts the send queue while the account is locked or paused. Search indexing saves its progress in batches instead of after every room.
