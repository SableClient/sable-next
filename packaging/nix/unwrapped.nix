{
  lib,
  stdenv,
  src,
  rustPlatform,
  fetchPnpmDeps,
  pnpm_12,
  pnpmConfigHook,
  nodejs_26,
  sable-wasm-bindgen-cli,
  binaryen,
  lld,
}:

let
  pnpm = pnpm_12;
in
stdenv.mkDerivation (finalAttrs: {
  pname = "sable-unwrapped";
  inherit (lib.importJSON ../../package.json) version;
  inherit src;

  __structuredAttrs = true;
  strictDeps = true;

  cargoDeps = rustPlatform.fetchCargoVendor {
    inherit (finalAttrs) src;
    hash = "sha256-cNsyltA8yOZslwn7cjf7fFlXX0B6s+mUDTUhJfN6sX8=";
  };

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    inherit pnpm;
    fetcherVersion = 4;
    hash = "sha256-wXeh3bx6XGVsdA7jbaQFqrCyVe8ppRu1YHw8f1K5Xt4=";
  };

  nativeBuildInputs = [
    pnpm
    (pnpmConfigHook.override { inherit pnpm; })
    nodejs_26
    sable-wasm-bindgen-cli
    binaryen
    lld
    rustPlatform.rust.rustc
    rustPlatform.rust.cargo
    rustPlatform.cargoSetupHook
  ];

  env = {
    SABLE_FOSS = "1";
    VITE_APP_VERSION = finalAttrs.version;
    VITE_BUILD_HASH = src.shortRev or src.dirtyShortRev or "";
  };

  buildPhase = ''
    runHook preBuild
    pnpm build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    cp -r dist $out
    runHook postInstall
  '';

  meta = {
    description = "Sable rewrite in Rust and Svelte. An almost stable Matrix client";
    homepage = "https://git.sable.moe/SableClient/sable-next";
    license = lib.licenses.agpl3Plus;
    maintainers = with lib.maintainers; [ quadradical ];
    platforms = lib.platforms.all;
  };
})
