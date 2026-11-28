import { Action, Keyset, legendOf } from "./keys";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getRepo, loadRepos } from "./config";
import * as git from "./git";
import { isJsonObject, isJsonString, type JsonValue } from "./json";
import type { Mux, MuxPane } from "./mux";
import { EXPLORE_TAB } from "./orchestration";
import { metaDir, worktreePath } from "./paths";
import { dim, fit, inverse } from "./term";
import { run } from "./util";

/**
 * The @explore tab: a detached checkout of each repo's default branch at `<root>/@explore/<repo>`, to run its apps and
 * open it in the editor without claiming anything. `syncPlan` moves it only when that loses no local work.
 */

/** How often the chosen repo's checkout is fast-forwarded while its tab is focused. */
export const SYNC_MS = 5 * 60_000;

export const exploreDir = (repo: string) => worktreePath(EXPLORE_TAB, repo);

const selectedFile = () => join(metaDir(), "explore.json");

/** The repo picked last, so a restarted pane opens on it. */
export function readSelected(): string | undefined {
  try {
    const raw: JsonValue = JSON.parse(readFileSync(selectedFile(), "utf8"));

    return isJsonObject(raw) && isJsonString(raw.repo) ? raw.repo : undefined;
  } catch {
    return undefined;
  }
}

export function writeSelected(repo: string) {
  mkdirSync(dirname(selectedFile()), { recursive: true });
  writeFileSync(selectedFile(), `${JSON.stringify({ repo })}\n`);
}

export const exploreRepos = (): string[] => Object.keys(loadRepos()).sort();

/** `run` with at most one call per key in flight: a call while one runs gets its promise, a later call starts anew. */
export function singleFlight<V>(run: (key: string) => Promise<V>): (key: string) => Promise<V> {
  const inFlight = new Map<string, Promise<V>>();

  return (key) => {
    const running = inFlight.get(key);

    if (running) return running;

    const started = run(key).finally(() => inFlight.delete(key));
    inFlight.set(key, started);

    return started;
  };
}

export interface SyncFacts {
  exists: boolean;
  /** Tracked files changed. Untracked files don't count: checking out the tip keeps them. */
  dirty: boolean;
  /** HEAD is already in the default branch's history, so moving to its tip loses nothing. */
  onDefaultBranch: boolean;
}

export const SyncStep = { Add: "add", Move: "move", KeepDirty: "keep-dirty", KeepAhead: "keep-ahead" } as const;

export type SyncStep = (typeof SyncStep)[keyof typeof SyncStep];

/** What a sync does: add a missing checkout, move a clean one to the tip, and leave local edits or commits alone. */
export function syncPlan(f: SyncFacts): SyncStep {
  if (!f.exists) return SyncStep.Add;

  if (f.dirty) return SyncStep.KeepDirty;

  return f.onDefaultBranch ? SyncStep.Move : SyncStep.KeepAhead;
}

const trackedDirty = (dir: string) => run(["git", "-C", dir, "status", "--porcelain", "--untracked-files=no"]).stdout.trim() !== "";

/** Bring `repo`'s explore checkout to the tip of its default branch. Returns a message for the panel, or undefined. */
export function syncExplore(repo: string): string | undefined {
  const spec = getRepo(repo);
  const dir = exploreDir(repo);
  const exists = existsSync(dir);

  if (exists) git.fetch(spec);

  const tip = `origin/${git.defaultBranch(spec)}`;

  const facts: SyncFacts = exists
    ? { exists, dirty: trackedDirty(dir), onDefaultBranch: run(["git", "-C", dir, "merge-base", "--is-ancestor", "HEAD", tip]).ok }
    : { exists, dirty: false, onDefaultBranch: true };

  switch (syncPlan(facts)) {
    case SyncStep.Add:
      mkdirSync(dirname(dir), { recursive: true });
      git.addWorktree(spec, dir);

      return undefined;
    case SyncStep.Move: {
      // git overwrites ignored files by default; a local ignored file the tip adds is the user's to keep
      const moved = run(["git", "-C", dir, "checkout", "--quiet", "--no-overwrite-ignore", "--detach", tip]);

      return moved.ok ? undefined : `${repo}: could not move to ${tip}: ${moved.stderr.trim()}`;
    }

    case SyncStep.KeepDirty:
      return `${repo} has local changes; left where it is`;
    case SyncStep.KeepAhead:
      return `${repo} has commits not on ${tip}; left where it is`;
  }
}

const TERMINAL_PREFIX = `${EXPLORE_TAB} · terminal`;

export const terminalTitle = (repo: string) => `${TERMINAL_PREFIX} · ${repo}`;

const terminalsIn = (panes: MuxPane[]) => panes.filter((p) => !p.exited && p.tab === EXPLORE_TAB && p.title.startsWith(TERMINAL_PREFIX));

export interface TerminalDeps {
  mux: Mux;
  self: string[];
}

function openTerminal(repo: string, deps: TerminalDeps): string | undefined {
  const anchor = deps.mux.ownPaneId();

  if (!anchor) return "could not find this pane to open the terminal under";

  const opened = deps.mux.newPane({
    anchor,
    direction: "down",
    title: terminalTitle(repo),
    cwd: exploreDir(repo),
    command: [...deps.self, "explore", "shell", repo],
    closeOnExit: true,
  });

  return opened ? undefined : "could not open the terminal";
}

/** Leave one terminal open, on `repo`: another repo's is closed, a missing one opened. */
export function showTerminal(repo: string, deps: TerminalDeps): string | undefined {
  const open = terminalsIn(deps.mux.listPanes());

  for (const p of open.filter((p) => p.title !== terminalTitle(repo))) deps.mux.closePane(p.id);

  return open.some((p) => p.title === terminalTitle(repo)) ? undefined : openTerminal(repo, deps);
}

/** The terminal button: close `repo`'s terminal when open, else open it. */
export function toggleTerminal(repo: string, deps: TerminalDeps): string | undefined {
  const open = terminalsIn(deps.mux.listPanes()).filter((p) => p.title === terminalTitle(repo));

  if (!open.length) return openTerminal(repo, deps);

  for (const p of open) deps.mux.closePane(p.id);

  return undefined;
}

/** Rows above and below the repo list in `renderPicker`. */
export const PICKER_CHROME = 4;

/** Rows the repo list gets in a picker `height` rows tall. */
const pickerBody = (height: number) => Math.max(1, height - PICKER_CHROME);

/** The first repo shown, so the selected one stays inside a list `height` rows tall (chrome included). */
export function pickerOffset(selected: number, count: number, height: number): number {
  const body = pickerBody(height);

  return Math.max(0, Math.min(selected - Math.floor(body / 2), count - body));
}

export interface PickerView {
  repos: string[];
  selected: number;
  /** Repos with a checkout already, marked in the list. */
  checkedOut: ReadonlySet<string>;
  width: number;
  height: number;
  message?: string;
}

/** The repo picker: the registered repos that fit, the selected one inverted. */
export function renderPicker(v: PickerView): string[] {
  const offset = pickerOffset(v.selected, v.repos.length, v.height);
  const shown = v.repos.slice(offset, offset + pickerBody(v.height));

  const list = shown.map((repo, i) => {
    const line = fit(`  ${v.checkedOut.has(repo) ? "●" : "○"} ${repo}`, v.width);

    return offset + i === v.selected ? inverse(line) : line;
  });

  const empty = v.repos.length ? [] : [fit("  no repos registered; add one with `overbridge repo add <name> <url>`", v.width)];

  return [fit(" explore: pick a repo to run on its default branch", v.width), "", ...empty, ...list, "", fit(v.message ?? dim(` ${legendOf(Keyset.explore, { [Action.Enter]: "open" })}   click open`), v.width)];
}

/** The repo at 0-based screen `row`, if that row shows one. */
export function pickerHit(row: number, repos: readonly string[], selected: number, height: number): string | undefined {
  const i = row - 2;
  const body = pickerBody(height);

  return i >= 0 && i < body ? repos[pickerOffset(selected, repos.length, height) + i] : undefined;
}
