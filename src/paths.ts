import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function root(): string {
  return resolve(process.env.WS_ROOT ?? join(homedir(), "workspaces"));
}

export const metaDir = () => join(root(), ".ws");
export const reposFile = () => join(root(), "repos.toml");
export const barePath = (repo: string) => join(root(), ".bare", `${repo}.git`);
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
 * The workspace this process is bound to. WS_NAME (set for workspace Claude
 * sessions) wins over cwd so a bound Claude stays bound even after `cd`.
 */
export function currentWorkspace(cwd = process.cwd()): string | undefined {
  return process.env.WS_NAME || workspaceOf(cwd);
}

/** argv that re-invokes this CLI, for hooks and zellij panes. */
export function selfCommand(): string[] {
  if (process.env.WS_SELF) return process.env.WS_SELF.split(" ");
  const script = process.argv[1];
  if (script && /\.[cm]?[jt]s$/.test(script)) return [process.execPath, script];
  return [process.execPath];
}
