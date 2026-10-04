# Maintainer: Sable Maintainers <https://git.sable.moe/SableClient/sable-next>

pkgname=sable-nightly-bin
# pkgver mirrors the release version with '-' replaced by '.', so each nightly
# sorts above the last. _relver keeps the original form for the asset URL.
pkgver=0.0.2.nightly.261004082933.4541fa8b4216
pkgrel=1
_relver=0.0.2-nightly.261004082933.4541fa8b4216
pkgdesc="A Matrix client (nightly builds)"
arch=('x86_64' 'aarch64')
url="https://git.sable.moe/SableClient/sable-next"
license=('AGPL-3.0-or-later')
# The bundled CEF runtime needs Chromium's system libraries, not webkit2gtk.
depends=(
  'gtk3'
  'nss'
  'nspr'
  'mesa'
  'libdrm'
  'libxkbcommon'
  'alsa-lib'
  'libcups'
  'libpipewire'
  'libayatana-appindicator'
  'xdg-utils'
  'xorg-xwayland'
  'hicolor-icon-theme'
  'desktop-file-utils'
)
provides=('sable')
conflicts=('sable' 'sable-bin')
options=('!strip' '!debug')
install=${pkgname}.install
source_x86_64=("${pkgname}-${pkgver}-x86_64.deb::${url}/releases/download/nightly-${_relver}/sable-next-${_relver}-linux-x86_64.deb")
source_aarch64=("${pkgname}-${pkgver}-aarch64.deb::${url}/releases/download/nightly-${_relver}/sable-next-${_relver}-linux-aarch64.deb")
sha256sums_x86_64=('cd7655580610260e6ea360096a6c3189e5831d280f5bc44187fc5b09205b8afe')
sha256sums_aarch64=('0000000000000000000000000000000000000000000000000000000000000000')

package() {
  # bsdtar reads whichever compression nfpm used for data.tar.*
  bsdtar -O -xf "${srcdir}/${pkgname}-${pkgver}-${CARCH}.deb" 'data.tar*' \
    | bsdtar -xp -C "${pkgdir}"
  find "${pkgdir}" -type d -exec chmod 755 {} +
}
