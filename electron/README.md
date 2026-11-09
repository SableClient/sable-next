# Electron packaging and update metadata

Build the web assets with `pnpm build`, then run
`pnpm --dir electron package --linux`, `--mac` or `--win`.
Set `VERSION` to override the root package version. macOS builds include a DMG and an update ZIP.
For a stable package, build the web assets and package with `SABLE_BUILD_FLAVOR=stable`.

To build `Sable Sandboxed`, run `SABLE_BUILD_FLAVOR=stable pnpm build`, then
`pnpm --dir electron package --sandboxed --mac`. It uses the MAS runtime with App Sandbox
and Hardened Runtime. Signing requires the team's Developer ID Application certificate;
pass `-c.mac.identity=YOUR_TEAM_ID` to use another team.

Packages are written to `electron/release/sandboxed`. The app stores data in its own
`moe.sable.client.sandboxed` container and requires a fresh login. Update by installing
a new DMG. It shares stable's link schemes; macOS must route links to the app you are
using.

`package.mjs` picks `electron-builder.stable.yml` or `electron-builder.nightly.yml`, both
extending `electron-builder.yml`, from `SABLE_BUILD_FLAVOR`: only `stable` builds the stable
package. Stable builds keep the Tauri identity (`moe.sable.client`) and its data directory;
nightlies keep the Tauri nightly identity (`moe.sable.next.nightly`) and install alongside
stable as `Sable Nightly`.
On first launch the app copies the Tauri app's permission grants, telemetry consent and
smooth-scrolling choice (`src/tauri-import.ts`).

Sign-in opens the system browser and returns to a one-shot listener on `127.0.0.1`
(RFC 8252 loopback redirect).

Link schemes are unchanged by app renames: stable uses `moe.sable.app` and `sable`;
nightly uses `moe.sable.next`, not `moe.sable.next.nightly`.
Flatpak, deb and rpm declare them in their desktop entry. Only AppImage, tarball and
development runs register a handler in `~/.local/share/applications` at startup.

Update feeds:

- Stable: `https://git.sable.moe/SableClient/sable-next/releases/download/latest/`
- Nightly: `https://git.sable.moe/SableClient/sable-next/releases/download/nightly/`

Packaging generates `latest-mac.yml`, `latest-linux.yml`, `latest-linux-arm64.yml` and `latest.yml` (Windows); versions containing
`-nightly.` use `nightly` instead of `latest`. `--publish never` disables
electron-builder uploads but still generates these manifests.

CI runs `node electron/publish-updates.mjs` with `TAG`, `VERSION`, `SHA` and
`FORGEJO_TOKEN`. The tagged release must exist. `FORGEJO_URL` and
`FORGEJO_REPOSITORY` default to this repository.

The script uploads installers and blockmaps to the tagged release, then publishes
channel manifests with versioned download URLs. Failed uploads leave the channel
manifest unchanged. Nightly pruning preserves releases referenced by those manifests.

The main process uses `electron-updater` with the feed for the channel chosen in
Settings → About. Stable macOS releases are signed and notarized, so they can install updates. Nightlies built without the signing secrets are unsigned and cannot.
Pass `-c.extraMetadata.autoUpdate=false` to disable it.

## Proxy

Pass Chromium's `--proxy-server` switch:

```sh
# Linux
sable --proxy-server=socks5://127.0.0.1:9050
# macOS
open -a Sable --args --proxy-server=socks5://127.0.0.1:9050
# Windows
Sable.exe --proxy-server=socks5://127.0.0.1:9050
```

It applies to the window and the Sable core. `socks5://` resolves host names on the proxy,
`socks://` is SOCKS4 and `host:port` is an HTTP proxy. Credentials and per-scheme rules
(`http=a:1;https=b:2`) are not supported, and the core refuses to start with the latter.

Calls use WebRTC over UDP, which SOCKS does not carry. Set Settings → Calls → Network interfaces
for calls to "Only through a proxy" to keep them off the direct route.
