#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
log=$(mktemp)

# Only the fixed-output derivations carry hashes, so there's no need to build the app.
# A second pass fixes the wasm-bindgen-cli vendor hash after its crate hash.
for attempt in 1 2 3; do
  if nix build -L --keep-going --no-link \
    .#sable-unwrapped.pnpmDeps \
    .#sable-unwrapped.cargoDeps \
    .#sable-wasm-bindgen-cli.src \
    .#sable-wasm-bindgen-cli.cargoDeps 2>&1 | tee "$log" >&2; then
    exit 0
  fi
  mismatches=$(grep -E '(specified|got):' "$log" | grep -oE 'sha256-\S+' | paste - - || true)
  [ -n "$mismatches" ] || break
  while read -r old new; do
    sed -i "s|$old|$new|" packaging/nix/*.nix
  done <<<"$mismatches"
done

echo 'nix build still fails after fixing hashes' >&2
exit 1
