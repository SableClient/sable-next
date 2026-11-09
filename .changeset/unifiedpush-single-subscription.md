---
default: patch
---

On Android, notifications through ntfy and other UnifiedPush Matrix gateways are no longer dropped. Each account keeps a single subscription with the distributor, and a distributor that requires VAPID no longer makes registration fail.
