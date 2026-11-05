# SPDX-License-Identifier: AGPL-3.0-or-later
{
  inputs.nixpkgs.url = "https://channels.nixos.org/nixos-unstable/nixexprs.tar.zst";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      forAllSystems =
        f:
        lib.genAttrs [
          "x86_64-linux"
          "aarch64-linux"
          "aarch64-darwin"
        ] (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          callPackage = lib.callPackageWith (pkgs // packages // { src = self; });
          packages = {
            sable-wasm-bindgen-cli = callPackage ./packaging/nix/wasm-bindgen-cli.nix { };
            sable-unwrapped = callPackage ./packaging/nix/unwrapped.nix { };
            sable = callPackage ./packaging/nix/sable.nix { };
            default = packages.sable;
          }
          // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            sable-desktop = callPackage ./packaging/nix/desktop.nix { };
          };
        in
        packages
      );

      checks = forAllSystems (
        pkgs:
        let
          inherit (self.packages.${pkgs.stdenv.hostPlatform.system}) sable-unwrapped;
          pnpmCheck =
            name: script:
            sable-unwrapped.overrideAttrs {
              pname = "sable-${name}";
              postPatch = "";
              buildPhase = ''
                pnpm wasm:dev
                pnpm exec svelte-kit sync
                pnpm run ${script}
              '';
              installPhase = "touch $out";
            };
        in
        lib.mapAttrs pnpmCheck {
          lint = "lint";
          fmt = "fmt:check";
          test = "test";
          typecheck = "check";
          knip = "knip";
        }
        // {
          build = self.packages.${pkgs.stdenv.hostPlatform.system}.sable;
        }
      );
    };
}
