# Copyright 2026 SableClient contributors
# Distributed under the terms of the GNU General Public License v2

EAPI=8

inherit unpacker xdg

DESCRIPTION="A Matrix client"
HOMEPAGE="https://sable.moe https://git.sable.moe/SableClient/sable-next"
SRC_URI="
	amd64? ( https://git.sable.moe/SableClient/sable-next/releases/download/v${PV}/sable-${PV}-amd64.deb )
	arm64? ( https://git.sable.moe/SableClient/sable-next/releases/download/v${PV}/sable-${PV}-arm64.deb )
"
S="${WORKDIR}"

LICENSE="AGPL-3+"
SLOT="0"
KEYWORDS="-* ~amd64 ~arm64"
RESTRICT="bindist mirror strip test"

RDEPEND="
	app-accessibility/at-spi2-core:2
	dev-libs/nss
	media-libs/alsa-lib
	media-libs/mesa[gbm(+)]
	media-video/pipewire
	net-print/cups
	sys-apps/util-linux
	x11-libs/gtk+:3
	x11-libs/libdrm
	x11-libs/libnotify
	x11-libs/libxkbcommon
	x11-libs/libXScrnSaver
	x11-libs/libXtst
	x11-misc/xdg-utils
"

QA_PREBUILT="opt/Sable/*"

src_install() {
	# Updates come from Portage.
	rm -f opt/Sable/resources/app-update.yml || die
	# The desktop entry declares the link schemes.
	echo gentoo > opt/Sable/resources/package-type || die

	insinto /opt
	doins -r opt/Sable
	fperms +x /opt/Sable/sable /opt/Sable/chrome_crashpad_handler
	fperms 4755 /opt/Sable/chrome-sandbox
	dosym -r /opt/Sable/sable /usr/bin/sable

	insinto /usr/share
	doins -r usr/share/applications usr/share/icons
}
