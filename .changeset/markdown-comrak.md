---
default: patch
---

Math now works in the same message as a colour or time function, and survives switching the composer between rich and plain text.
A few rare inputs read differently: `$x$5` and `$$x$` are no longer math, and a table can start under a line that has no `|`.
