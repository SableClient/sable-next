#!/bin/bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$project_root"
archives=()
for architecture in ${ARCHS}; do
  case "${PLATFORM_NAME}:$architecture" in
    iphoneos:arm64) rust_target=aarch64-apple-ios ;;
    iphonesimulator:arm64) rust_target=aarch64-apple-ios-sim ;;
    iphonesimulator:x86_64) rust_target=x86_64-apple-ios ;;
    *) echo "Unsupported notification extension target: ${PLATFORM_NAME}:$architecture" >&2; exit 1 ;;
  esac
  CARGO_TARGET_DIR="$project_root/target/ios-notification" cargo build --locked --release --package sable-push --target "$rust_target"
  archives+=("$project_root/target/ios-notification/$rust_target/release/libsable_push.a")
done
xcrun lipo -create "${archives[@]}" -output "${DERIVED_FILE_DIR}/libsable_push.a"
