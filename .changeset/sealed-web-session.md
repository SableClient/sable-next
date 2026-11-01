---
default: patch
---

Seal the saved web session with a browser key that page scripts cannot export. The browser keeps that key in its profile, so the web app still relies on the device being protected. Safari cannot keep such a key in the background worker, so there the session stays unsealed.
