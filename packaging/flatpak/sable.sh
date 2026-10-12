#!/bin/sh
export TMPDIR="$XDG_RUNTIME_DIR/app/$FLATPAK_ID"
export ZYPAK_CEF_LIBRARY_PATH=/app/sable-next/libcef.so
exec zypak-wrapper /app/sable-next/sable-next "$@"
