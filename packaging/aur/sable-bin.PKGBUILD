# Maintainer: Sable Maintainers <https://git.sable.moe/SableClient/sable-next>

pkgname=sable-bin
pkgver=2.0.0
pkgrel=1
pkgdesc="A Matrix client"
arch=('x86_64' 'aarch64')
url="https://git.sable.moe/SableClient/sable-next"
license=('AGPL-3.0-or-later')
depends=(
  'webkit2gtk-4.1'
  'gtk3'
  'libayatana-appindicator'
  'hicolor-icon-theme'
  'desktop-file-utils'
  'xdg-utils'
)
provides=('sable')
conflicts=('sable' 'sable-nightly-bin')
options=('!strip' '!debug')
install=${pkgname}.install
source_x86_64=("${pkgname}-${pkgver}-x86_64.deb::${url}/releases/download/v${pkgver}/sable-next-${pkgver}-linux-x86_64.deb")
source_aarch64=("${pkgname}-${pkgver}-aarch64.deb::${url}/releases/download/v${pkgver}/sable-next-${pkgver}-linux-aarch64.deb")
sha256sums_x86_64=('0000000000000000000000000000000000000000000000000000000000000000')
sha256sums_aarch64=('0000000000000000000000000000000000000000000000000000000000000000')

package() {
  bsdtar -O -xf "${srcdir}/${pkgname}-${pkgver}-${CARCH}.deb" 'data.tar*' \
    | bsdtar -xp -C "${pkgdir}"
  find "${pkgdir}" -type d -exec chmod 755 {} +
}
