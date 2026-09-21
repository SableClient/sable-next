# Linux mobile idle behaviour

When inactive or hidden, pause presentation work and coalesce cache writes.
Keep Matrix sync, encryption, notifications, and action handling running while
the process is alive. Do not inhibit suspend for chat; reconnect and catch up
after resume.

If a sandboxed build must operate without windows, request the XDG Background
portal and handle denial or its absence. It is optional and user-approved.

This follows comparable Linux Matrix clients: Nheko throttles unfocused sync
handling and offscreen animations rather than stopping sync, while Fractal
keeps session notification handling separate from window activity.

- [Nheko release notes](https://github.com/Nheko-Reborn/nheko/releases)
- [Nheko behaviour described by Matrix.org](https://matrix.org/blog/2023/11/03/this-week-in-matrix-2023-11-03/)
- [Fractal session source](https://fractal-tobias-kuendig-a2308b584e67215e00d29986814e3bc2ee19fca1.pages.gitlab.gnome.org/src/fractal/session/model/session.rs.html)
- [GTK power-saver guidance](https://docs.gtk.org/gio/iface.PowerProfileMonitor.html)
- [XDG Background portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Background.html)
