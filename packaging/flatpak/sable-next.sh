#!/bin/sh
export TMPDIR="$XDG_RUNTIME_DIR/app/$FLATPAK_ID"
export ZYPAK_CEF_LIBRARY_PATH=/app/extra/sable-next/libcef.so
exec zypak-wrapper /app/extra/sable-next/sable-next "$@"
