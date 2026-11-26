# AUR packages

Stable releases ship as `sable` in Arch Linux's extra repository. The AUR only
carries nightly builds as `sable-nightly-bin`; update it through your AUR helper.
In-app updates are disabled because Electron's Debian installer bypasses pacman.

## Moving from `sable-bin`

`sable-bin` is no longer updated. Replace it with the official package:

```sh
sudo pacman -R sable-bin
sudo pacman -S sable
```

This keeps your account data and settings.

## Upgrading older packages

Older packages created launcher symlinks outside pacman's file list. The first
upgrade may fail with `/usr/bin/sable-nightly exists in filesystem`. Remove the
old package and reinstall:

```sh
sudo pacman -R sable-nightly-bin
paru -S sable-nightly-bin
```

This removes the old launcher and preserves your account data and settings.

If another package depends on Sable, remove only the launcher after checking
that `pacman -Qo` reports it as unowned and its target is
`/opt/Sable Nightly/sable-nightly`. Then retry the upgrade.

## Packaging

CI generates the PKGBUILD and `.SRCINFO` with the release version and checksum.
The package owns its launcher; pacman hooks refresh desktop and icon caches.
`desktop-file-utils` is also needed for per-user deep-link registration.
The bundled Chromium sandbox must be owned by root with mode `4755`.
