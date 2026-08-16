# Packages a prebuilt `dist`; building it here would need the Rust toolchain and
# mise-pinned wasm tooling for the WASM core.
#
#   pnpm build && docker build -t sable-next .

FROM caddy:2-alpine

# Strip the file capability set by the base image (cap_net_bind_service=+ep).
# With --cap-drop=ALL the bounding set is empty, and the kernel refuses to exec
# any binary that has file capabilities not present in the bounding set — even
# if those capabilities aren't actually needed at runtime (we listen on :8080).
RUN setcap -r /usr/bin/caddy

COPY dist /app
COPY Caddyfile /etc/caddy/Caddyfile

EXPOSE 8080
