#!/usr/bin/env bash
#MISE description="Package the Linux CEF build as a deb, an rpm and an AppImage"
#MISE tools={nfpm="2.47.0", "github:AppImage/appimagetool" = {version = "1.9.1", matching = ".AppImage"}}
# The tauri bundler cannot carry the CEF runtime, so the packages are assembled
# here instead.
#
# Usage: scripts/cef/package.sh [version] [display-name]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(grep -m1 '"version":' src-tauri/tauri.conf.json | sed 's/.*: *"\(.*\)".*/\1/')}"
: "${VERSION:?no version found in src-tauri/tauri.conf.json}"
DISPLAY_NAME="${2:-Sable Next}"

# deb sorts `~` before everything, so a prerelease stays below its release; rpm
# says the same with a release below 1.
DEB_VERSION="$VERSION"
RPM_VERSION="$VERSION"
RPM_RELEASE=1
if [[ "$VERSION" == *-* ]]; then
  DEB_VERSION="${VERSION%%-*}~${VERSION#*-}"
  RPM_VERSION="${VERSION%%-*}"
  RPM_RELEASE="0.${VERSION#*-}"
fi

# ARCH is read by appimagetool.
case "$(uname -m)" in
  x86_64) export ARCH=x86_64; NFPM_ARCH=amd64 ;;
  aarch64 | arm64) export ARCH=aarch64; NFPM_ARCH=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

STAGE="$ROOT/target/release"
OUT="$STAGE/bundle"
WORK="$STAGE/cef-pkg"

BIN_PATH="$STAGE/app"
[ -x "$BIN_PATH" ] || { echo "no binary at $BIN_PATH; run 'pnpm tauri:cef build' first" >&2; exit 1; }

if command -v appimagetool.AppImage >/dev/null 2>&1; then
  APPIMAGETOOL=appimagetool.AppImage
elif command -v appimagetool >/dev/null 2>&1; then
  APPIMAGETOOL=appimagetool
else
  echo "appimagetool not found" >&2
  exit 1
fi
command -v nfpm >/dev/null 2>&1 || { echo "nfpm not found" >&2; exit 1; }

rm -rf "$WORK"
mkdir -p "$OUT/deb" "$OUT/rpm" "$OUT/appimage"
bash scripts/cef/stage.sh "$WORK/stage" "$DISPLAY_NAME"

PKGROOT="$WORK/pkgroot"
mkdir -p "$PKGROOT/opt/sable-next" "$PKGROOT/usr/bin"
cp -a "$WORK/stage/runtime/." "$PKGROOT/opt/sable-next/"
cp -f "$BIN_PATH" "$PKGROOT/opt/sable-next/sable-next"
chmod 755 "$PKGROOT/opt/sable-next/sable-next"
cat > "$PKGROOT/usr/bin/sable-next" <<'EOF'
#!/bin/sh
exec /opt/sable-next/sable-next "$@"
EOF
chmod 755 "$PKGROOT/usr/bin/sable-next"
cp -a "$WORK/stage/share/." "$PKGROOT/usr/share/"

PKGROOT="$PKGROOT" PKG_ARCH="$NFPM_ARCH" PKG_VERSION="$DEB_VERSION" PKG_RELEASE=1 \
  nfpm pkg -f nfpm.yaml -p deb -t "$OUT/deb/sable-next-${VERSION}-linux-${ARCH}.deb"
PKGROOT="$PKGROOT" PKG_ARCH="$NFPM_ARCH" PKG_VERSION="$RPM_VERSION" PKG_RELEASE="$RPM_RELEASE" \
  nfpm pkg -f nfpm.yaml -p rpm -t "$OUT/rpm/sable-next-${VERSION}-linux-${ARCH}.rpm"

APPDIR="$WORK/SableNext.AppDir"
mkdir -p "$APPDIR/usr/bin"
cp -a "$WORK/stage/runtime/." "$APPDIR/usr/bin/"
cp -f "$BIN_PATH" "$APPDIR/usr/bin/sable-next"
chmod 755 "$APPDIR/usr/bin/sable-next"
stage_appindicator() {
  local dest="$1" main dep
  main="$(ldconfig -p 2>/dev/null | awk '$1 == "libayatana-appindicator3.so.1" { v = $NF } END { print v }')"
  [ -n "$main" ] || main="$(find /usr/lib /usr/lib64 /lib -name libayatana-appindicator3.so.1 2>/dev/null | sort | tail -n1)"
  if [ -z "$main" ] || [ ! -e "$main" ]; then
    echo "warning: libayatana-appindicator3.so.1 not found; the AppImage ships without a tray" >&2
    return 0
  fi
  {
    echo "$main"
    ldd "$main" 2>/dev/null | awk '/=>/ { print $3 }' | grep -iE 'ayatana|dbusmenu|indicator|ido' || true
  } | sort -u | while read -r dep; do
    if [ -e "$dep" ]; then
      cp -Lf "$dep" "$dest/$(basename "$dep")"
    fi
  done
}
stage_appindicator "$APPDIR/usr/bin"

rm -f "$APPDIR/usr/bin/chrome-sandbox"

cp -f "$WORK/stage/share/applications/sable-next.desktop" "$APPDIR/sable-next.desktop"
cp -f src-tauri/icons/128x128.png "$APPDIR/sable-next.png"
cat > "$APPDIR/AppRun" <<'EOF'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
export LD_LIBRARY_PATH="$HERE/usr/bin${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$HERE/usr/bin/sable-next" "$@"
EOF
chmod 755 "$APPDIR/AppRun"

APPIMAGE_EXTRACT_AND_RUN=1 "$APPIMAGETOOL" "$APPDIR" \
  "$OUT/appimage/sable-next-${VERSION}-linux-${ARCH}.AppImage"

echo "packages in $OUT"
