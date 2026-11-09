# Gentoo overlay

```sh
eselect repository add sable git https://git.sable.moe/SableClient/gentoo-sable.git
emaint sync -r sable
emerge --ask net-im/sable-bin
```

In-app updates are disabled; update through Portage.

## Packaging

This directory is the template for
[gentoo-sable](https://git.sable.moe/SableClient/gentoo-sable). On stable releases,
CI renders it with `scripts/ci/render-gentoo.sh` and pushes it there. The push needs
the `GENTOO_OVERLAY_TOKEN` secret.

Run `pkgcheck scan` here to lint it.
