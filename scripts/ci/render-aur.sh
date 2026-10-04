#!/usr/bin/env bash
#MISE description="Render an AUR package directory from packaging/aur"
# Usage: render-aur.sh <pkgname> <pkgver> <relver> <sha256> <outdir>
# makepkg refuses to run as root and is not on the runners, so .SRCINFO is
# written here from the sourced PKGBUILD in the order makepkg prints it.
set -euo pipefail

pkg="$1" ver="$2" relver="$3" sha="$4" out="$5"
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../packaging/aur" && pwd)"

mkdir -p "$out"
sed \
  -e "s/^pkgver=.*/pkgver=${ver}/" \
  -e "s/^pkgrel=.*/pkgrel=1/" \
  -e "s/^_relver=.*/_relver=${relver}/" \
  -e "s/^sha256sums_x86_64=.*/sha256sums_x86_64=('${sha}')/" \
  "$dir/$pkg.PKGBUILD" > "$out/PKGBUILD"
cp "$dir/$pkg.install" "$out/$pkg.install"

cd "$out"
(
  set +u
  # shellcheck disable=SC1091
  source ./PKGBUILD
  list() { local key="$1"; shift; local item; for item in "$@"; do printf '\t%s = %s\n' "$key" "$item"; done; }
  {
    printf 'pkgbase = %s\n' "$pkgname"
    printf '\tpkgdesc = %s\n' "$pkgdesc"
    printf '\tpkgver = %s\n' "$pkgver"
    printf '\tpkgrel = %s\n' "$pkgrel"
    printf '\turl = %s\n' "$url"
    printf '\tinstall = %s\n' "$install"
    list arch "${arch[@]}"
    list license "${license[@]}"
    list depends "${depends[@]}"
    list provides "${provides[@]}"
    list conflicts "${conflicts[@]}"
    list options "${options[@]}"
    list source_x86_64 "${source_x86_64[@]}"
    list sha256sums_x86_64 "${sha256sums_x86_64[@]}"
    printf '\npkgname = %s\n' "$pkgname"
  } > .SRCINFO
)
