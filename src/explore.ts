import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getRepo, loadRepos } from "./config";
import * as git from "./git";
import { isJsonObject, isJsonString, type JsonValue } from "./json";
import type { Mux, MuxPane } from "./mux";
import { metaDir, worktreePath } from "./paths";
import { dim, fit, inverse } from "./term";
import { run } from "./util";

/**
 * The @explore tab: a checkout of each repo's default branch, kept up to date, to run its apps and open it in the
 * editor without claiming anything. Each repo gets a detached worktree at `<root>/@explore/<repo>`; nothing is ever
 * committed there, so `syncPlan` only moves it while it is clean and still on the default branch's history.
 */
export const EXPLORE_TAB = "@explore";

/** How often the chosen repo's checkout is fast-forwarded while the panel is open. */
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

export interface SyncFacts {
  exists: boolean;
  dirty: boolean;
  /** HEAD is already in the default branch's history, so moving to its tip loses nothing. */
  onMain: boolean;
}

export const SyncStep = { Add: "add", Move: "move", KeepDirty: "keep-dirty", KeepAhead: "keep-ahead" } as const;

export type SyncStep = (typeof SyncStep)[keyof typeof SyncStep];

/** What a sync does: add a missing checkout, move a clean one to the tip, and leave local edits or commits alone. */
export function syncPlan(f: SyncFacts): SyncStep {
  if (!f.exists) return SyncStep.Add;

  if (f.dirty) return SyncStep.KeepDirty;

  return f.onMain ? SyncStep.Move : SyncStep.KeepAhead;
}

/** Bring `repo`'s explore checkout to the tip of its default branch. Returns a note for the panel, or undefined. */
export function syncExplore(repo: string): string | undefined {
  const spec = getRepo(repo);
  const dir = exploreDir(repo);
  const exists = existsSync(dir);

  if (exists) git.fetch(spec);

  const tip = `origin/${git.defaultBranch(spec)}`;

  const facts: SyncFacts = exists
    ? { exists, dirty: git.isDirty(dir), onMain: run(["git", "-C", dir, "merge-base", "--is-ancestor", "HEAD", tip]).ok }
    : { exists, dirty: false, onMain: true };

  switch (syncPlan(facts)) {
    case SyncStep.Add:
      mkdirSync(dirname(dir), { recursive: true });
      git.addWorktree(spec, dir);

      return undefined;
    case SyncStep.Move: {
      const moved = run(["git", "-C", dir, "checkout", "--quiet", "--detach", tip]);

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

export interface PickerView {
  repos: string[];
  selected: number;
  /** Repos with a checkout already, marked in the list. */
  checkedOut: ReadonlySet<string>;
  width: number;
  message?: string;
}

/** The repo picker: one row per registered repo, the selected one inverted. Pure, so it is unit-tested. */
export function renderPicker(v: PickerView): string[] {
  const rows = [fit(" explore: pick a repo to run on its default branch", v.width), ""];

  if (!v.repos.length) rows.push(fit("  no repos registered; add one with `overbridge repo add <name> <url>`", v.width));

  v.repos.forEach((repo, i) => {
    const line = fit(`  ${v.checkedOut.has(repo) ? "●" : "○"} ${repo}`, v.width);
    rows.push(i === v.selected ? inverse(line) : line);
  });

  rows.push("", fit(v.message ?? dim(" enter/click: open · j/k: move · q: quit"), v.width));

  return rows;
}

/** Index of the repo row at 0-based screen `row`, if any. */
export const pickerHit = (row: number, count: number): number | undefined => {
  const i = row - 2;

  return i >= 0 && i < count ? i : undefined;
};
