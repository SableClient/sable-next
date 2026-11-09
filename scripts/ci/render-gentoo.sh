#!/usr/bin/env bash
# Usage: render-gentoo.sh <version> <debdir> <outdir>
# Portage is not on the runners, so the Manifest is written by hand.
set -euo pipefail

if [ $# -lt 3 ]; then
  echo "Usage: render-gentoo.sh <version> <debdir> <outdir>" >&2
  exit 1
fi

ver="$1" debs="$2" out="$3"
if ! [[ "$ver" =~ ^[0-9]+(\.[0-9]+)*$ ]]; then
  echo "render-gentoo.sh: '$ver' is not a stable release version" >&2
  exit 1
fi
src="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../packaging/gentoo" && pwd)"
pkg=net-im/sable-bin

shopt -s nullglob
templates=("$src/$pkg"/sable-bin-*.ebuild)
if [ "${#templates[@]}" -ne 1 ]; then
  echo "render-gentoo.sh: expected one ebuild in $src/$pkg" >&2
  exit 1
fi

mkdir -p "$out/profiles" "$out/metadata" "$out/$pkg"
cp "$src/profiles/repo_name" "$out/profiles/"
cp "$src/metadata/layout.conf" "$out/metadata/"
cp "$src/README.md" "$out/"
cp "$src/$pkg/metadata.xml" "$out/$pkg/"
rm -f "$out/$pkg"/*.ebuild "$out/$pkg/Manifest"

ebuild="$out/$pkg/sable-bin-${ver}.ebuild"
cp "${templates[0]}" "$ebuild"

: > "$out/$pkg/Manifest"
found=0
for arch in amd64 arm64; do
  deb="$debs/sable-${ver}-${arch}.deb"
  if [ ! -f "$deb" ]; then
    echo "render-gentoo.sh: no $arch .deb; dropping $arch" >&2
    sed -i -e "/^\t${arch}? (/d" -e "s/ ~${arch}//" "$ebuild"
    continue
  fi
  found=1
  printf 'DIST %s %s BLAKE2B %s SHA512 %s\n' \
    "$(basename "$deb")" \
    "$(stat -c %s "$deb")" \
    "$(b2sum "$deb" | awk '{print $1}')" \
    "$(sha512sum "$deb" | awk '{print $1}')" >> "$out/$pkg/Manifest"
done
if [ "$found" -eq 0 ]; then
  echo "render-gentoo.sh: no .deb found in $debs" >&2
  exit 1
fi
