import { getRepo } from "./config";
import { focusedDiff, type Noise } from "./focused-diff";
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
    command: kind === "diff" ? [...deps.self, "diff", "--ws", ws, "--follow"] : terminalCommand(ws, deps),
    closeOnExit: false,
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

/** difftastic's side-by-side layout needs at least this many columns; narrower panes get its inline display. */
export const DIFFT_SIDE_BY_SIDE_MIN_COLUMNS = 100;

/** The diff renderers `diff` can use, best first. */
export type DiffTool = "difft" | "delta" | "git";

/** The renderer to use given which programs are on PATH: difftastic, else delta, else git's own colours. */
export const pickDiffTool = (have: { difft: boolean; delta: boolean }): DiffTool => (have.difft ? "difft" : have.delta ? "delta" : "git");

export interface DifftCommand {
  args: string[];
  env: Record<string, string>;
}

/** `git` arguments and extra environment that make git render `base` against the worktree with difftastic at `columns` wide. */
export function difftCommand(base: string, columns: number): DifftCommand {
  return {
    args: ["-c", "diff.external=difft", "diff", "--ext-diff", base],
    env: { DFT_COLOR: "always", DFT_WIDTH: String(columns), DFT_DISPLAY: columns >= DIFFT_SIDE_BY_SIDE_MIN_COLUMNS ? "side-by-side-show-both" : "inline" },
  };
}

/** One repo's diff, rendered; empty when nothing changed. */
function renderRepo(dir: string, base: string, columns: number, tool: DiffTool): string {
  if (tool === "difft") {
    const { args, env } = difftCommand(base, columns);
    const out = Bun.spawnSync({ cmd: ["git", "-C", dir, ...args], cwd: spawnCwd(), env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });

    if (out.exitCode === 0) return out.stdout.toString();

    // difft missing or crashed: an empty result would read as "no changes", so show the plain diff instead
    return renderRepo(dir, base, columns, pickDiffTool({ difft: false, delta: !!Bun.which("delta") }));
  }

  const raw = Bun.spawnSync({ cmd: ["git", "-C", dir, "diff", "-w", "--color=always", base], cwd: spawnCwd(), stdout: "pipe", stderr: "pipe" });

  if (!raw.stdout.length || tool === "git") return raw.stdout.toString();

  const piped = Bun.spawnSync({ cmd: deltaCommand(columns), cwd: dir, stdin: raw.stdout, stdout: "pipe", stderr: "pipe" });

  // delta rejecting a flag (its options differ between versions) must not read as no changes
  return piped.exitCode === 0 ? piped.stdout.toString() : raw.stdout.toString();
}

/** One repo's focused diff (noise collapsed); the plain renderer's output if git fails, so a failure never reads as no changes. */
function renderRepoFocused(dir: string, base: string, columns: number, tool: DiffTool, keep: ReadonlySet<Noise>): string {
  const raw = Bun.spawnSync({ cmd: ["git", "-C", dir, "-c", "core.quotepath=off", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--submodule=short", "--ignore-submodules=none", "-M", "-U3", base, "--"], cwd: spawnCwd(), stdout: "pipe", stderr: "pipe" });

  return raw.exitCode === 0 ? focusedDiff(raw.stdout.toString(), { keep }) : renderRepo(dir, base, columns, tool);
}

/** How long a following diff waits before it looks for changes again. */
export const FOLLOW_POLL_MS = 5_000;

/** A pager that exits sooner than this was not shown (no `less` on PATH): wait before looking again instead of spinning. */
const PAGER_MIN_MS = 200;

/**
 * `overbridge diff [--follow]`: each claimed repo's changes since it left the default branch (committed
 * and uncommitted), rendered with difftastic (else delta, else plain git) and paged. With `follow` it never
 * exits: it waits for changes, and `q` in the pager refreshes. With `focus` it prints the focused diff instead
 * (see `src/focused-diff.ts`).
 */
export function diff(ws: string, follow = false, focus?: FocusMode) {
  for (;;) {
    const out = renderDiff(ws, process.stdout.columns ?? 80, undefined, focus);

    if (out) {
      const startedMs = Date.now();
      Bun.spawnSync({ cmd: ["less", "-R"], cwd: spawnCwd(), stdin: Buffer.from(out), stdout: "inherit", stderr: "inherit" });

      if (follow && Date.now() - startedMs < PAGER_MIN_MS) Bun.sleepSync(FOLLOW_POLL_MS);
    } else {
      if (follow) process.stdout.write("\x1b[2J\x1b[H");
      console.log("no changes");
      Bun.sleepSync(follow ? FOLLOW_POLL_MS : 2_000);
    }

    if (!follow) return;
  }
}

/** Focused mode: show the diff without its noise; `keep` lists the noise kinds to show anyway. */
export interface FocusMode {
  keep: ReadonlySet<Noise>;
}

/** Every claimed repo's changes since it left the default branch (committed and uncommitted), rendered; empty when none. */
export function renderDiff(ws: string, columns: number, tool: DiffTool = pickDiffTool({ difft: !!Bun.which("difft"), delta: !!Bun.which("delta") }), focus?: FocusMode): string {
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
    const text = focus ? renderRepoFocused(dir, base, columns, tool, focus.keep) : renderRepo(dir, base, columns, tool);

    if (!text.trim()) continue;

    out += `${repos.length > 1 ? `\x1b[1m── ${repo} ──\x1b[0m\n` : ""}${text}\n`;
  }

  return out;
}
