import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

let quietLegacy = false;
const warned = new Set<string>();

/** Silence legacy-env warnings, for the guard hook that runs on every tool call. */
export const silenceLegacyWarnings = () => {
  quietLegacy = true;
};

/** `OVERBRIDGE_<name>`, falling back to the pre-rename `WS_<name>` with a one-time warning. */
export function envVar(name: "ROOT" | "NAME" | "SELF" | "SESSION"): string | undefined {
  const current = process.env[`OVERBRIDGE_${name}`];
  if (current !== undefined) return current;
  const legacy = process.env[`WS_${name}`];
  if (legacy !== undefined && !quietLegacy && !warned.has(name)) {
    warned.add(name);
    console.error(`overbridge: WS_${name} is deprecated, use OVERBRIDGE_${name}`);
  }
  return legacy;
}

export function root(): string {
  return resolve(envVar("ROOT") ?? join(homedir(), "workspaces"));
}

/** State dir. Renames the pre-rename `.ws` dir in place the first time it is seen. */
export function metaDir(): string {
  const dir = join(root(), ".overbridge");
  const legacy = join(root(), ".ws");
  if (!existsSync(dir) && existsSync(legacy)) renameSync(legacy, dir);
  return dir;
}
export const reposFile = () => join(root(), "repos.toml");
export const barePath = (repo: string) => join(root(), ".bare", `${repo}.git`);
/** `gh repo list` cache; outside OVERBRIDGE_ROOT so workspace Claudes may read it. */
export const ghReposCache = () =>
  join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "overbridge", "github-repos.json");
export const wsDir = (ws: string) => join(root(), ws);
export const worktreePath = (ws: string, repo: string) => join(wsDir(ws), repo);

export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Workspace name containing `dir`, if any. */
export function workspaceOf(dir: string): string | undefined {
  const rel = relative(root(), resolve(dir));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return;
  const first = rel.split(sep)[0]!;
  return first.startsWith(".") ? undefined : first;
}

/**
 * The workspace this process is bound to. OVERBRIDGE_NAME (set for workspace Claude
 * sessions) wins over cwd so a bound Claude stays bound even after `cd`.
 */
export function currentWorkspace(cwd = process.cwd()): string | undefined {
  return envVar("NAME") || workspaceOf(cwd);
}

/** argv that re-invokes this CLI, for hooks and zellij panes. */
export function selfCommand(): string[] {
  if (envVar("SELF")) return envVar("SELF")!.split(" ");
  const script = process.argv[1];
  if (script && /\.[cm]?[jt]s$/.test(script)) return [process.execPath, script];
  return [process.execPath];
}
