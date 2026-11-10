{
  description = "overbridge — multi-repo workspaces with bound Claude sessions in zellij";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      forAllSystems = f: nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ] (s: f nixpkgs.legacyPackages.${s});
    in
    {
      packages = forAllSystems (pkgs: {
        default = pkgs.stdenvNoCC.mkDerivation {
          pname = "overbridge";
          version = "0.1.0";
          src = ./.;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          dontBuild = true;
          installPhase = ''
            mkdir -p $out/share/overbridge $out/bin
            # the plugins load from here: see pluginSettings in src/plugins.ts
            cp -r src .claude-plugin plugin plugin-review $out/share/overbridge/
            # OVERBRIDGE_SELF=overbridge keeps generated hooks/layouts pointing at the PATH binary,
            # not a store path that goes stale after the next rebuild.
            makeWrapper ${pkgs.bun}/bin/bun $out/bin/overbridge \
              --add-flags $out/share/overbridge/src/cli.ts \
              --set-default OVERBRIDGE_SELF overbridge \
              --set OVERBRIDGE_VERSION ${self.shortRev or self.dirtyShortRev or "dev"} \
              --suffix PATH : ${pkgs.lib.makeBinPath [ pkgs.git pkgs.gh pkgs.zellij ]}
            ln -s overbridge $out/bin/ws
          '';
          meta.mainProgram = "overbridge";
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell { packages = [ pkgs.bun pkgs.just ]; };
      });
    };
}
