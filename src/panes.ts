import { getRepo } from "./config";
import * as git from "./git";
import { selfCommand, worktreePath, wsDir } from "./paths";
import { loadRepoConfig } from "./project-config";
import { getWorkspace, readState } from "./state";
import type { PaneKind } from "./top";
import type { ZellijExec } from "./tab";
import { run, spawnCwd } from "./util";

/**
 * The claude / terminal / diff buttons. Claude is always open at the left of the tab; terminal and
 * diff open on demand in a column to its right, and a second press closes them. Panes are found by
 * the title the layout and this module give them, so nothing is stored.
 */

export interface ZellijPane {
  id: number;
  is_plugin?: boolean;
  title?: string;
  tab_name?: string;
  exited?: boolean;
}

export const paneTitle = (ws: string, kind: PaneKind) => `${ws} · ${kind}`;

/** The live pane of `kind` in `ws`'s tab, if any. */
export function findPane(panes: ZellijPane[], ws: string, kind: PaneKind): ZellijPane | undefined {
  return panes.find((p) => !p.is_plugin && !p.exited && p.tab_name === ws && p.title === paneTitle(ws, kind));
}

/** Where a terminal opens: the first claimed repo's worktree, else the workspace dir. */
export function terminalDir(ws: string): string {
  const repo = terminalRepo(ws);
  return repo ? worktreePath(ws, repo) : wsDir(ws);
}

const terminalRepo = (ws: string): string | undefined => Object.keys(getWorkspace(readState(), ws).repos)[0];

/** The terminal's command: the user's shell inside the repo's dev shell, or nothing (zellij's default shell). */
function terminalCommand(ws: string, deps: PaneDeps): string[] {
  const repo = terminalRepo(ws);
  if (!repo) return [];
  try {
    if (!loadRepoConfig(worktreePath(ws, repo), repo).shell) return [];
  } catch {
    return [];
  }
  return ["--", ...deps.self, "shell", repo, "--ws", ws, "--", process.env.SHELL || "sh"];
}

export interface PaneDeps {
  /** Run a zellij action; returns stdout, or undefined on failure. */
  zellij: (args: string[]) => string | undefined;
  self: string[];
}

const defaultDeps = (): PaneDeps => ({
  zellij: (args) => {
    const r = run(["zellij", "action", ...args]);
    return r.ok ? r.stdout : undefined;
  },
  self: selfCommand(),
});

const listPanes = (deps: PaneDeps): ZellijPane[] => {
  try {
    return JSON.parse(deps.zellij(["list-panes", "--json"]) ?? "[]") as ZellijPane[];
  } catch {
    return [];
  }
};

const target = (p: ZellijPane) => `terminal_${p.id}`;

/**
 * Press of a pane button. Claude: focus it. Terminal / diff: close it if open, else open it to the
 * right of claude, or below the other right-hand pane when one is already there.
 */
export function togglePane(ws: string, kind: PaneKind, deps: PaneDeps = defaultDeps()): string | undefined {
  const panes = listPanes(deps);
  const claude = findPane(panes, ws, "claude");
  if (kind === "claude") {
    if (!claude) return "no claude pane in this tab";
    deps.zellij(["focus-pane-id", target(claude)]);
    return undefined;
  }
  const open = findPane(panes, ws, kind);
  if (open) {
    deps.zellij(["close-pane", "--pane-id", target(open)]);
    if (claude) deps.zellij(["focus-pane-id", target(claude)]);
    return undefined;
  }
  const other = findPane(panes, ws, kind === "terminal" ? "diff" : "terminal");
  const anchor = other ?? claude;
  if (!anchor) return "no claude pane in this tab";
  deps.zellij(["focus-pane-id", target(anchor)]);
  const args = ["new-pane", "--direction", other ? "down" : "right", "--name", paneTitle(ws, kind), "--cwd", terminalDir(ws)];
  if (kind === "diff") args.push("--close-on-exit", "--", ...deps.self, "diff", "--ws", ws);
  else args.push(...terminalCommand(ws, deps));
  return deps.zellij(args) === undefined ? `could not open ${kind}` : undefined;
}

/**
 * Focus the Claude pane of `tab`'s tab; false when the tab has none (then focus stays where zellij put it).
 * Takes a `ZellijExec` so `overbridge go` can reach the session from outside it.
 */
export function focusClaude(tab: string, exec: ZellijExec): boolean {
  const listed = exec(["zellij", "action", "list-panes", "--json"]);
  let panes: ZellijPane[] = [];
  try {
    panes = listed.ok ? (JSON.parse(listed.stdout) as ZellijPane[]) : [];
  } catch {
    panes = [];
  }
  const claude = findPane(panes, tab, "claude");
  if (!claude) return false;
  return exec(["zellij", "action", "focus-pane-id", target(claude)]).ok;
}

/** Delta needs room for side-by-side; below this many columns it is turned off. */
export const SIDE_BY_SIDE_MIN_COLUMNS = 140;

/** The pager command for a diff: the user's `delta` (git config styles), whitespace hidden by the caller's `-w`. */
export function deltaCommand(columns: number): string[] {
  return ["delta", "--paging=never", `--width=${columns}`, ...(columns < SIDE_BY_SIDE_MIN_COLUMNS ? ["--no-side-by-side"] : [])];
}

/**
 * `overbridge diff [--ws]`: each claimed repo's changes since it left the default branch (committed
 * and uncommitted), whitespace ignored, rendered with delta from the user's git config and paged.
 */
export function diff(ws: string) {
  const columns = process.stdout.columns ?? 80;
  const repos = Object.keys(getWorkspace(readState(), ws).repos);
  let out = "";
  for (const repo of repos) {
    const dir = worktreePath(ws, repo);
    const def = (() => {
      try {
        return git.defaultBranch(getRepo(repo));
      } catch {
        return undefined;
      }
    })();
    const base = (def && run(["git", "-C", dir, "merge-base", "HEAD", `origin/${def}`]).stdout) || "HEAD";
    const raw = Bun.spawnSync({ cmd: ["git", "-C", dir, "diff", "-w", "--color=always", base], cwd: spawnCwd(), stdout: "pipe", stderr: "pipe" });
    if (!raw.stdout.length) continue;
    const text = Bun.which("delta")
      ? Bun.spawnSync({ cmd: deltaCommand(columns), cwd: dir, stdin: raw.stdout, stdout: "pipe", stderr: "pipe" }).stdout.toString()
      : raw.stdout.toString();
    out += `${repos.length > 1 ? `\x1b[1m── ${repo} ──\x1b[0m\n` : ""}${text}\n`;
  }
  if (!out) {
    console.log("no changes (whitespace ignored)");
    Bun.sleepSync(2_000);
    return;
  }
  Bun.spawnSync({ cmd: ["less", "-R"], cwd: spawnCwd(), stdin: Buffer.from(out), stdout: "inherit", stderr: "inherit" });
}
