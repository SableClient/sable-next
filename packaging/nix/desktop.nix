{
  lib,
  stdenv,
  src,
  sable-unwrapped,
  rustPlatform,
  pnpm_12,
  pnpmConfigHook,
  nodejs_26,
  pkg-config,
  aws-lc,
  sqlcipher,
  openssl,
  pipewire,
  libpulseaudio,
  autoPatchelfHook,
  makeWrapper,
  electron_45,
  darwin,
}:

let
  pnpm = pnpm_12;
  electron = electron_45;
  web = sable-unwrapped.overrideAttrs (old: {
    env = old.env // {
      SABLE_BUILD_FLAVOR = "stable";
    };
  });
in
stdenv.mkDerivation (finalAttrs: {
  pname = "sable-desktop";
  inherit (sable-unwrapped) version cargoDeps pnpmDeps;
  inherit src;

  __structuredAttrs = true;
  strictDeps = true;

  postPatch = lib.optionalString stdenv.hostPlatform.isDarwin ''
    # --deep does not exist in nixpkgs' codesign
    substituteInPlace electron/after-pack.mjs --replace-fail "'--deep', " ""
  '';

  nativeBuildInputs = [
    pnpm
    (pnpmConfigHook.override { inherit pnpm; })
    nodejs_26
    pkg-config
    rustPlatform.bindgenHook
    rustPlatform.rust.rustc
    rustPlatform.rust.cargo
    rustPlatform.cargoSetupHook
    makeWrapper
  ]
  ++ lib.optionals stdenv.hostPlatform.isDarwin [ darwin.sigtool ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];

  buildInputs = [
    aws-lc
    sqlcipher
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [
    openssl
    pipewire
    libpulseaudio
    stdenv.cc.cc.lib
  ];

  env = {
    ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
    SABLE_BUILD_FLAVOR = "stable";
    VERSION = finalAttrs.version;
  };

  buildPhase = ''
    runHook preBuild

    cp -r --no-preserve=mode ${web} dist
    cp -r ${electron.dist} electron-dist
    chmod -R u+w electron-dist
    pnpm --dir electron package ${if stdenv.hostPlatform.isDarwin then "--mac" else "--linux"} --dir \
      -c.electronDist=$PWD/electron-dist \
      -c.electronVersion=${electron.version} \
      -c.extraMetadata.autoUpdate=false

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
  ''
  + lib.optionalString stdenv.hostPlatform.isDarwin ''
    mkdir -p $out/Applications
    mv electron/release/mac*/Sable.app $out/Applications

    codesign --force --sign - $out/Applications/Sable.app

    makeWrapper $out/Applications/Sable.app/Contents/MacOS/Sable $out/bin/sable
  ''
  + lib.optionalString stdenv.hostPlatform.isLinux ''
    mkdir -p $out/share/sable
    cp -r electron/release/linux*-unpacked/resources/. $out/share/sable
    echo nix > $out/share/sable/package-type

    makeWrapper ${lib.getExe electron} $out/bin/sable \
      --add-flags $out/share/sable/app.asar \
      --set-default ELECTRON_FORCE_IS_PACKAGED 1

    install -Dm644 packaging/flatpak/moe.sable.client.desktop -t $out/share/applications
    for size in 32 64 128 256; do
      install -Dm644 packaging/flatpak/icons/''${size}x''${size}.png \
        $out/share/icons/hicolor/''${size}x''${size}/apps/moe.sable.client.png
    done
  ''
  + ''
    runHook postInstall
  '';

  dontStrip = stdenv.hostPlatform.isDarwin;

  meta = sable-unwrapped.meta // {
    description = "Sable desktop app, a Matrix client";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "aarch64-darwin"
    ];
    mainProgram = "sable";
  };
})
