FROM node:24-bookworm AS node

FROM rust:1.97-bookworm AS frontend

WORKDIR /src
COPY --from=node /usr/local /usr/local
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
COPY patches ./patches
ARG TARGETARCH
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates curl \
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
    && cargo install wasm-bindgen-cli --version 0.2.130 --locked \
    && corepack enable pnpm \
    && corepack prepare pnpm@12.14.0 --activate
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm run build:server

FROM rust:1.97-bookworm AS build

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . .
COPY --from=frontend /src/dist ./dist
RUN CARGO_INCREMENTAL=0 cargo build --release -p sable-server

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates curl tini \
    && useradd --system --uid 10001 --create-home --home-dir /var/lib/sable sable \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/sable-server /usr/local/bin/sable-server
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
