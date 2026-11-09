import { readdirSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { currentWorkspace, root, selfCommand } from "./paths";

/**
 * External subcommands, git-style: `overbridge <name>` for a name overbridge does not know runs the
 * first `overbridge-<name>` executable on PATH. Built-in commands always win.
 */
export const EXTERNAL_PREFIX = "overbridge-";
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const isExecutableFile = (file: string) => {
  try {
    const s = statSync(file);
    return s.isFile() && (s.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

/** Path of the executable behind `overbridge <name>`, if one is on PATH. */
export function externalCommand(name: string, path = process.env.PATH ?? ""): string | undefined {
  if (!NAME_RE.test(name)) return;
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, EXTERNAL_PREFIX + name);
    if (isExecutableFile(file)) return file;
  }
}

/** Names of every external subcommand on PATH, sorted. */
export function externalCommands(path = process.env.PATH ?? ""): string[] {
  const names = new Set<string>();
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry.slice(EXTERNAL_PREFIX.length);
      if (entry.startsWith(EXTERNAL_PREFIX) && NAME_RE.test(name) && isExecutableFile(join(dir, entry))) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * What an external subcommand is told: the resolved root, how to call overbridge back, and the workspace
 * this process is bound to, if any.
 */
export function externalEnv(): Record<string, string> {
  const env: Record<string, string> = { OVERBRIDGE_ROOT: root(), OVERBRIDGE_SELF: selfCommand().join(" ") };
  const ws = currentWorkspace();
  if (ws) env.OVERBRIDGE_NAME = ws;
  return env;
}

/** The `overbridge help` section listing external subcommands, or nothing when there are none. */
export function externalHelp(path = process.env.PATH ?? ""): string {
  const names = externalCommands(path);
  if (!names.length) return "";
  return `\nExternal (overbridge-<name> on PATH)\n${names.map((n) => `  overbridge ${n}`).join("\n")}\n`;
}
