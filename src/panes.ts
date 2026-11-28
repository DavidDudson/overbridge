import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRepo } from "./config";
import * as git from "./git";
import { selfCommand, worktreePath, wsDir } from "./paths";
import { loadRepoConfig } from "./project-config";
import { getWorkspace, readState } from "./state";
import { defaultMux, type Mux, type MuxPane } from "./mux";
import type { PaneKind } from "./top";
import { run, shellQuote, spawnCwd } from "./util";

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
export function deltaCommand(columns: number, sideBySide = false): string[] {
  // the user's git config may turn side-by-side on, so the inline view says so explicitly
  return ["delta", "--paging=never", `--width=${columns}`, sideBySide && columns >= SIDE_BY_SIDE_MIN_COLUMNS ? "--side-by-side" : "--no-side-by-side"];
}

/** difftastic's side-by-side layout needs at least this many columns; narrower views get its inline display. */
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
export function difftCommand(base: string, columns: number, sideBySide = false): DifftCommand {
  return {
    args: ["-c", "diff.external=difft", "diff", "--ext-diff", base],
    env: { DFT_COLOR: "always", DFT_WIDTH: String(columns), DFT_DISPLAY: sideBySide && columns >= DIFFT_SIDE_BY_SIDE_MIN_COLUMNS ? "side-by-side-show-both" : "inline" },
  };
}

/** One repo's diff, rendered; empty when nothing changed. */
function renderRepo(dir: string, base: string, columns: number, tool: DiffTool, sideBySide: boolean): string {
  if (tool === "difft") {
    const { args, env } = difftCommand(base, columns, sideBySide);
    const out = Bun.spawnSync({ cmd: ["git", "-C", dir, ...args], cwd: spawnCwd(), env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });

    if (out.exitCode === 0) return out.stdout.toString();

    // difft missing or crashed: an empty result would read as "no changes", so show the plain diff instead
    return renderRepo(dir, base, columns, pickDiffTool({ difft: false, delta: !!Bun.which("delta") }), sideBySide);
  }

  const raw = Bun.spawnSync({ cmd: ["git", "-C", dir, "diff", "-w", "--color=always", base], cwd: spawnCwd(), stdout: "pipe", stderr: "pipe" });

  if (!raw.stdout.length || tool === "git") return raw.stdout.toString();

  const piped = Bun.spawnSync({ cmd: deltaCommand(columns, sideBySide), cwd: dir, stdin: raw.stdout, stdout: "pipe", stderr: "pipe" });

  // delta rejecting a flag (its options differ between versions) must not read as no changes
  return piped.exitCode === 0 ? piped.stdout.toString() : raw.stdout.toString();
}

/** How long a following diff waits before it looks for changes again. */
export const FOLLOW_POLL_MS = 5_000;

/** A pager that exits sooner than this was not shown (no `less` on PATH): wait before looking again instead of spinning. */
const PAGER_MIN_MS = 200;

/** Environment variable carrying the shell command `d` runs in the inline pager. */
const OVERLAY_ENV = "OVERBRIDGE_DIFF_OVERLAY";

/** `--lesskey-src` arrived in less 582; an older less rejects it and exits without paging. */
const LESSKEY_SRC_MIN_VERSION = 582;

/** Whether the installed `less` takes `--lesskey-src`; without it the pager runs plain and `d` does nothing. */
function lessTakesLesskey(): boolean {
  try {
    const version = /^less (\d+)/.exec(Bun.spawnSync({ cmd: ["less", "--version"], stdout: "pipe", stderr: "pipe" }).stdout.toString());

    return version !== null && Number(version[1]) >= LESSKEY_SRC_MIN_VERSION;
  } catch {
    return false;
  }
}

/**
 * The less key file for the diff pager: in the inline pane `d` runs the shell command in `OVERLAY_ENV` (`!` runs it
 * from inside less, and the second newline answers its "press RETURN"); in the overlay itself `d` quits, so the same
 * key toggles it away.
 */
export const diffLesskey = (opensOverlay: boolean) => `#command\n${opensOverlay ? `d noaction !eval "$${OVERLAY_ENV}"\\n\\n` : "d quit"}\n`;

/** Page `out`, with the `d` key when `overlayCommand` is given and less supports it. */
function diffPager(out: string, overlayCommand: string | undefined) {
  if (!lessTakesLesskey()) {
    Bun.spawnSync({ cmd: ["less", "-R"], cwd: spawnCwd(), stdin: Buffer.from(out), stdout: "inherit", stderr: "inherit" });

    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "overbridge-less-"));
  const keyFile = join(dir, "keys");

  // the command travels in the environment: less rewrites `%`/`#` and lesskey `\\`/`^` in a typed command, and the shell expands it intact
  const env = { ...process.env };

  if (overlayCommand !== undefined) env[OVERLAY_ENV] = overlayCommand;

  try {
    writeFileSync(keyFile, diffLesskey(overlayCommand !== undefined));
    Bun.spawnSync({
      cmd: ["less", "-R", `--lesskey-src=${keyFile}`],
      cwd: spawnCwd(),
      env,
      stdin: Buffer.from(out),
      stdout: "inherit",
      stderr: "inherit",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Open the side-by-side viewer as a floating pane over the current one. */
export function openDiffOverlay(ws: string, deps: PaneDeps = defaultDeps()): string | undefined {
  const opened = deps.mux.newPane({
    anchor: deps.mux.ownPaneId() ?? "",
    direction: "right",
    title: `${paneTitle(ws, "diff")} (side by side)`,
    cwd: terminalDir(ws),
    command: [...deps.self, "diff", "--ws", ws, "--side-by-side"],
    closeOnExit: true,
    floating: true,
  });

  return opened ? undefined : "could not open the side-by-side overlay";
}

/**
 * `overbridge diff [--follow]`: each claimed repo's changes since it left the default branch (committed
 * and uncommitted), rendered inline with difftastic (else delta, else plain git) and paged. With `follow` it never
 * exits: it waits for changes, and `q` in the pager refreshes. `sideBySide` renders the one-shot overlay that `d` opens.
 */
export function diff(ws: string, follow = false, sideBySide = false) {
  const self = selfCommand();
  const overlayCommand = sideBySide ? undefined : [...self, "diff", "--ws", ws, "--overlay"].map(shellQuote).join(" ");

  for (;;) {
    const out = renderDiff(ws, process.stdout.columns ?? 80, undefined, sideBySide);

    if (out) {
      const startedMs = Date.now();
      diffPager(out, overlayCommand);

      if (follow && Date.now() - startedMs < PAGER_MIN_MS) Bun.sleepSync(FOLLOW_POLL_MS);
    } else {
      if (follow) process.stdout.write("\x1b[2J\x1b[H");
      console.log("no changes");
      Bun.sleepSync(follow ? FOLLOW_POLL_MS : 2_000);
    }

    if (!follow || sideBySide) return;
  }
}

/** Every claimed repo's changes since it left the default branch (committed and uncommitted), rendered; empty when none. */
export function renderDiff(
  ws: string,
  columns: number,
  tool: DiffTool = pickDiffTool({ difft: !!Bun.which("difft"), delta: !!Bun.which("delta") }),
  sideBySide = false,
): string {
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
    const text = renderRepo(dir, base, columns, tool, sideBySide);

    if (!text.trim()) continue;

    out += `${repos.length > 1 ? `\x1b[1m── ${repo} ──\x1b[0m\n` : ""}${text}\n`;
  }

  return out;
}
