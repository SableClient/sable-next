#!/usr/bin/env bash
#MISE description="Copy the CEF runtime libraries next to a built binary"
# Usage: scripts/cef/copy-libs.sh [debug|release] [dest-dir]
#   dest-dir defaults to target/<profile>, beside the binary.
set -euo pipefail

PROFILE="${1:-debug}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="${2:-$ROOT/target/$PROFILE}"

case "$(uname -m)" in
  x86_64) CEF_ARCH=x86_64 ;;
  aarch64 | arm64) CEF_ARCH=aarch64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

CEF_DIR="$(
  find "$ROOT/target" -type d -name "cef_linux_$CEF_ARCH" \
    -path "*/$PROFILE/build/*" -print -quit 2>/dev/null || true
)"
if [ -z "$CEF_DIR" ]; then
  echo "cef_linux_$CEF_ARCH not found under target/**/$PROFILE/build — build with --features cef first." >&2
  exit 1
fi

CEF_LIB="$CEF_DIR/libcef.so"
[ -f "$CEF_LIB" ] || { echo "libcef.so not found in $CEF_DIR." >&2; exit 1; }

# A runtime left over from an older crate aborts at startup with no useful
# message, and carries no version file, so read the major out of the library.
CEF_VERSION="$(awk '
  /^\[\[package\]\]$/ { in_cef = 0 }
  /^name = "cef"$/ { in_cef = 1 }
  in_cef && /^version = / { gsub(/"/, "", $3); print $3; exit }
' "$ROOT/Cargo.lock")"
[ -n "$CEF_VERSION" ] || { echo "no resolved cef version in Cargo.lock." >&2; exit 1; }

RUNTIME_MAJOR="$(
  strings -a "$CEF_LIB" \
    | grep -Eio '[0-9]{3}\.[0-9]+\.[0-9]+\+g[^[:space:]]+\+chromium-[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' \
    | awk -F. 'NR == 1 { print $1; exit }'
)" || true
[ -n "$RUNTIME_MAJOR" ] || { echo "no CEF runtime version in $CEF_LIB." >&2; exit 1; }
if [ "$RUNTIME_MAJOR" != "${CEF_VERSION%%.*}" ]; then
  echo "CEF runtime major $RUNTIME_MAJOR does not match the resolved cef ${CEF_VERSION}." >&2
  exit 1
fi

mkdir -p "$DEST"
echo "copying the CEF runtime from $CEF_DIR to $DEST"
cp -f "$CEF_DIR"/*.so* "$DEST/" 2>/dev/null || true
cp -f "$CEF_DIR"/chrome_crashpad_handler "$DEST/" 2>/dev/null || true
cp -f "$CEF_DIR"/*.pak "$CEF_DIR"/*.dat "$CEF_DIR"/*.bin "$CEF_DIR"/*.json "$DEST/" 2>/dev/null || true

cp -f "$ROOT/packaging/licenses/CEF-LICENSE.txt" "$DEST/CEF-LICENSE.txt"

# 1.3 GB unstripped against 241 MB stripped.
for lib in "$DEST/libcef.so" "$DEST/libEGL.so" "$DEST/libGLESv2.so"; do
  [ -f "$lib" ] && strip -s "$lib" 2>/dev/null || true
done

# The full locale set is 49 MB against 570 KB for en-US alone.
mkdir -p "$DEST/locales"
cp -f "$CEF_DIR/locales/en-US.pak" "$DEST/locales/" 2>/dev/null || true

echo "done."
