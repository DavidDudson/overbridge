{
  description = "ws — multi-repo workspaces with bound Claude sessions in zellij";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      forAllSystems = f: nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ] (s: f nixpkgs.legacyPackages.${s});
    in
    {
      packages = forAllSystems (pkgs: {
        default = pkgs.stdenvNoCC.mkDerivation {
          pname = "ws";
          version = "0.1.0";
          src = ./.;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          dontBuild = true;
          installPhase = ''
            mkdir -p $out/share/ws $out/bin
            cp -r src $out/share/ws/
            # WS_SELF=ws keeps generated hooks/layouts pointing at the PATH binary,
            # not a store path that goes stale after the next rebuild.
            makeWrapper ${pkgs.bun}/bin/bun $out/bin/ws \
              --add-flags $out/share/ws/src/cli.ts \
              --set-default WS_SELF ws \
              --suffix PATH : ${pkgs.lib.makeBinPath [ pkgs.git pkgs.gh pkgs.zellij ]}
          '';
          meta.mainProgram = "ws";
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell { packages = [ pkgs.bun pkgs.just ]; };
      });
    };
}
