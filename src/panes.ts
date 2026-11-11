import { getRepo } from "./config";
import * as git from "./git";
import { selfCommand, worktreePath, wsDir } from "./paths";
import { loadRepoConfig } from "./project-config";
import { getWorkspace, readState } from "./state";
import { defaultMux, type Mux, type MuxPane } from "./mux";
import type { PaneKind } from "./top";
import { run, spawnCwd } from "./util";

/**
 * The claude / terminal / diff buttons. Claude is always open at the left of the tab; terminal and
 * diff open on demand in a column to its right, and a second press closes them. Panes are found by
 * the title the layout and this module give them, so nothing is stored.
 */

export const paneTitle = (ws: string, kind: PaneKind) => `${ws} · ${kind}`;

/** The live pane of `kind` in `ws`'s tab, if any. */
export function findPane(panes: MuxPane[], ws: string, kind: PaneKind): MuxPane | undefined {
  return panes.find((p) => !p.exited && p.tab === ws && p.title === paneTitle(ws, kind));
}

/** Where a terminal opens: the first claimed repo's worktree, else the workspace dir. */
export function terminalDir(ws: string): string {
  const repo = terminalRepo(ws);
  return repo ? worktreePath(ws, repo) : wsDir(ws);
}

const terminalRepo = (ws: string): string | undefined => Object.keys(getWorkspace(readState(), ws).repos)[0];

/** The terminal's command: the user's shell inside the repo's dev shell, or nothing (the multiplexer's default shell). */
function terminalCommand(ws: string, deps: PaneDeps): string[] {
  const repo = terminalRepo(ws);
  if (!repo) return [];
  try {
    if (!loadRepoConfig(worktreePath(ws, repo), repo).shell) return [];
  } catch {
    return [];
  }
  return [...deps.self, "shell", repo, "--ws", ws, "--", process.env.SHELL || "sh"];
}

export interface PaneDeps {
  mux: Mux;
  self: string[];
}

const defaultDeps = (): PaneDeps => ({ mux: defaultMux(), self: selfCommand() });

/**
 * Press of a pane button. Claude: focus it. Terminal / diff: close it if open, else open it to the
 * right of claude, or below the other right-hand pane when one is already there.
 */
export function togglePane(ws: string, kind: PaneKind, deps: PaneDeps = defaultDeps()): string | undefined {
  const { mux } = deps;
  const panes = mux.listPanes();
  const claude = findPane(panes, ws, "claude");
  if (kind === "claude") {
    if (!claude) return "no claude pane in this tab";
    mux.focusPane(claude.id);
    return undefined;
  }
  const open = findPane(panes, ws, kind);
  if (open) {
    mux.closePane(open.id);
    if (claude) mux.focusPane(claude.id);
    return undefined;
  }
  const other = findPane(panes, ws, kind === "terminal" ? "diff" : "terminal");
  const anchor = other ?? claude;
  if (!anchor) return "no claude pane in this tab";
  const opened = mux.newPane({
    anchor: anchor.id,
    direction: other ? "down" : "right",
    title: paneTitle(ws, kind),
    cwd: terminalDir(ws),
    command: kind === "diff" ? [...deps.self, "diff", "--ws", ws] : terminalCommand(ws, deps),
    closeOnExit: kind === "diff",
  });
  return opened ? undefined : `could not open ${kind}`;
}

/**
 * Focus the Claude pane of `tab`'s tab; false when the tab has none (then focus stays where the multiplexer put it).
 * Takes a `Mux` so `overbridge go` can reach the session from outside it.
 */
export function focusClaude(tab: string, mux: Mux): boolean {
  const claude = findPane(mux.listPanes(), tab, "claude");
  return claude !== undefined && mux.focusPane(claude.id);
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
