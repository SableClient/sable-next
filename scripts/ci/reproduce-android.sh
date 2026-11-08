#!/usr/bin/env bash
# Rebuilds a released FOSS APK the way IzzyOnDroid does and checks it against the
# published one. Runs as root in a fresh ubuntu:noble, from the tag's checkout, and
# builds as the runner user:
#
#   docker run --rm --platform linux/amd64 \
#     -v "$PWD:/shared/workdir/SableClient/sable-next" -w /shared/workdir/SableClient/sable-next \
#     ubuntu:noble@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac \
#     scripts/ci/reproduce-android.sh 2.1.7
set -euo pipefail

version="${1:?usage: reproduce-android.sh <version>}"
node_version=24.22.0
node_sha256=cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008
tools_url=https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip
tools_sha256=4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583
ndk_version="$(sed -n 's/^ANDROID_NDK_VERSION = "\(.*\)"$/\1/p' .mise/config.toml)"
platform="$(sed -n 's/^ANDROID_PLATFORM = "\(.*\)"$/\1/p' .mise/config.toml)"
build_tools="$(sed -n 's/^ANDROID_BUILD_TOOLS_VERSION = "\(.*\)"$/\1/p' .mise/config.toml)"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends apksigcopier build-essential ca-certificates curl \
  git openjdk-25-jdk-headless rustup unzip xz-utils

downloads="$(mktemp -d)"
curl -fsSLo "$downloads/node.tar.xz" \
  "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-x64.tar.xz"
echo "$node_sha256  $downloads/node.tar.xz" | sha256sum -c
tar -xJf "$downloads/node.tar.xz" -C /opt

export ANDROID_HOME=/usr/local/lib/android/sdk
curl -fsSLo "$downloads/tools.zip" "$tools_url"
echo "$tools_sha256  $downloads/tools.zip" | sha256sum -c
mkdir -p "$ANDROID_HOME/cmdline-tools"
unzip -q "$downloads/tools.zip" -d "$ANDROID_HOME/cmdline-tools"
mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
export PATH="/opt/node-v$node_version-linux-x64/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/build-tools/$build_tools:$PATH"
(yes || true) | sdkmanager --licenses >/dev/null
sdkmanager "platforms;android-36" "platforms;$platform" "build-tools;$build_tools" "ndk;$ndk_version"
export NDK_HOME="$ANDROID_HOME/ndk/$ndk_version"

npm install --global corepack@latest
corepack enable pnpm

useradd --home-dir /shared/workdir --no-create-home runner
chown runner: /shared/workdir
chown -R runner: "$PWD"

# IzzyOnDroid builds unsigned, then copies the signature over from our APK.
runuser -u runner -- env HOME=/shared/workdir PATH="/shared/workdir/.cargo/bin:$PATH" \
  ANDROID_HOME="$ANDROID_HOME" NDK_HOME="$NDK_HOME" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  bash -c 'pnpm install --frozen-lockfile && pnpm android:build --version "$1"' _ "$version"

curl -fsSLo "$downloads/released.apk" \
  "https://git.sable.moe/SableClient/sable-next/releases/download/v$version/sable-$version-android-aarch64-foss.apk"
apksigcopier compare --unsigned "$downloads/released.apk" \
  src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release-unsigned.apk
echo "sable-$version-android-aarch64-foss.apk is reproducible"
