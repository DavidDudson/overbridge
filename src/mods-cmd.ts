import { parseArgs } from "node:util";
import { installMod, listModLines, modsDir, removeModNamed, updateMods } from "./mods";
import { OverbridgeError } from "./util";

const USAGE = "usage: overbridge mods install <git-url|path> [--name x] | update [name] | ls | rm <name>";

/** `overbridge mods`: install, update, list and remove the Claude Code mods every workspace Claude loads. Returns the exit code. */
export function modsCommand(args: string[]): number {
  const { values, positionals } = parseArgs({ args, options: { name: { type: "string" } }, allowPositionals: true, strict: true });
  const [sub = "ls", arg, ...extra] = positionals;

  if (extra.length || (values.name !== undefined && sub !== "install")) {
    throw new OverbridgeError(USAGE);
  }

  if (sub === "install" && arg !== undefined) {
    installMod(arg, values.name);

    return 0;
  }

  if (sub === "update") {
    return updateMods(arg) ? 1 : 0;
  }

  if (sub === "ls" && arg === undefined) {
    const lines = listModLines();
    console.log(lines.length ? lines.join("\n") : `no mods installed in ${modsDir()}`);

    return 0;
  }

  if (sub === "rm" && arg !== undefined) {
    removeModNamed(arg);

    return 0;
  }

  throw new OverbridgeError(USAGE);
}
