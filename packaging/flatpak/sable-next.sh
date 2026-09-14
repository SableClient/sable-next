#!/bin/sh
export ZYPAK_CEF_LIBRARY_PATH=/app/extra/sable-next/libcef.so
exec zypak-wrapper /app/extra/sable-next/sable-next "$@"
