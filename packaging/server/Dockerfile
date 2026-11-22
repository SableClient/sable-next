# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv

# SecretsUsedInArgOrEnv flags SCCACHE_S3_KEY_PREFIX, a bucket path.

# Builds everything from source. CI skips the WASM build with
# `--build-context wasm=src/generated/wasm` and passes sccache credentials.

FROM node:26-bookworm AS node

FROM rust:1.100.0-bookworm AS rust
ARG TARGETARCH
ARG SCCACHE_VERSION=0.18.0
RUN case "$TARGETARCH" in \
         amd64) arch=x86_64 sha=45f1447fbe231e3037bde351ef70677dd212216c8d62ae7ca409fecc4d6acc89 ;; \
         arm64) arch=aarch64 sha=2b3284d5da3b46a47dc4229e75bb7b88ac4aa99c8d754fb7d2f84997e5a4354a ;; \
         *) echo "unsupported Docker architecture: $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && name="sccache-v$SCCACHE_VERSION-$arch-unknown-linux-musl" \
    && curl -fsSLo /tmp/sccache.tar.gz "https://github.com/mozilla/sccache/releases/download/v$SCCACHE_VERSION/$name.tar.gz" \
    && echo "$sha  /tmp/sccache.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/sccache.tar.gz -C /usr/local/bin --strip-components=1 "$name/sccache" \
    && rm /tmp/sccache.tar.gz
# Set by CI along with the aws_access_key_id and aws_secret_access_key secrets.
ARG SCCACHE_BUCKET=
ARG SCCACHE_ENDPOINT=
ARG SCCACHE_REGION=
ARG SCCACHE_S3_KEY_PREFIX=
ARG SCCACHE_S3_USE_SSL=
ENV CARGO_INCREMENTAL=0 \
    SCCACHE_BUCKET=$SCCACHE_BUCKET \
    SCCACHE_ENDPOINT=$SCCACHE_ENDPOINT \
    SCCACHE_REGION=$SCCACHE_REGION \
    SCCACHE_S3_KEY_PREFIX=$SCCACHE_S3_KEY_PREFIX \
    SCCACHE_S3_USE_SSL=$SCCACHE_S3_USE_SSL

FROM rust AS wasm-build
WORKDIR /src
COPY --from=node /usr/local /usr/local
ARG TARGETARCH
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates clang curl llvm \
    && rm -rf /var/lib/apt/lists/* \
    && case "$TARGETARCH" in \
         amd64) binaryen_arch=x86_64 ;; \
         arm64) binaryen_arch=aarch64 ;; \
         *) echo "unsupported Docker architecture: $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/WebAssembly/binaryen/releases/download/version_133/binaryen-version_133-${binaryen_arch}-linux.tar.gz" \
       | tar -xz -C /tmp \
    && install "/tmp/binaryen-version_133/bin/wasm-opt" /usr/local/bin/wasm-opt \
    && rustup target add wasm32-unknown-unknown \
    && cargo install wasm-bindgen-cli --version 0.2.130 --locked
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
# Node 25+ no longer ships corepack.
RUN npm install --global "$(node -p "require('./package.json').packageManager")"
COPY patches ./patches
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
ENV AR_wasm32_unknown_unknown=llvm-ar
RUN --mount=type=cache,id=sable-cargo-home,target=/var/cache/cargo \
    --mount=type=secret,id=aws_access_key_id,env=AWS_ACCESS_KEY_ID \
    --mount=type=secret,id=aws_secret_access_key,env=AWS_SECRET_ACCESS_KEY \
    if [ -n "$AWS_ACCESS_KEY_ID" ] && [ -n "$SCCACHE_BUCKET" ]; then export RUSTC_WRAPPER=sccache; fi \
    && CARGO_HOME=/var/cache/cargo pnpm wasm:build

FROM scratch AS wasm
COPY --from=wasm-build /src/src/generated/wasm /

FROM node AS frontend
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
# Node 25+ no longer ships corepack.
RUN npm install --global "$(node -p "require('./package.json').packageManager")"
COPY patches ./patches
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
COPY --from=wasm / src/generated/wasm/
RUN VITE_SABLE_SERVER_URL=/_sable/ws \
    VITE_SABLE_SERVER_VERSION="$(node -p "require('./package.json').version")" \
    pnpm exec vite build

FROM rust AS build
WORKDIR /src
COPY . .
COPY --from=frontend /src/dist ./dist
RUN --mount=type=cache,id=sable-cargo-home,target=/var/cache/cargo \
    --mount=type=secret,id=aws_access_key_id,env=AWS_ACCESS_KEY_ID \
    --mount=type=secret,id=aws_secret_access_key,env=AWS_SECRET_ACCESS_KEY \
    if [ -n "$AWS_ACCESS_KEY_ID" ] && [ -n "$SCCACHE_BUCKET" ]; then export RUSTC_WRAPPER=sccache; fi \
    && CARGO_HOME=/var/cache/cargo cargo build --locked --release -p sable-server \
    && cp target/release/sable-server /usr/local/bin/sable-server

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates curl tini \
    && useradd --system --uid 10001 --create-home --home-dir /var/lib/sable sable \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/sable-server /usr/local/bin/sable-server
COPY --from=frontend /src/dist /srv/sable

ENV SABLE_SERVER_FRONTEND_DIR=/srv/sable
ENV SABLE_SERVER_DATA_DIR=/var/lib/sable/data
ENV SABLE_SERVER_LISTEN_ADDR=0.0.0.0:18008
EXPOSE 18008
VOLUME ["/var/lib/sable"]
HEALTHCHECK --interval=30s --timeout=3s CMD curl --fail --silent http://127.0.0.1:18008/healthz || exit 1
WORKDIR /var/lib/sable
USER sable
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/sable-server"]
