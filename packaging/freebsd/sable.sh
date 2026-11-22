#!/bin/sh
exec /usr/local/bin/electron45 "$(dirname "$(realpath "$0")")/resources/app.asar" "$@"
