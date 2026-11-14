import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { stopChecksFor } from "./check-queue";
import { getRepo } from "./config";
import * as git from "./git";
import { HandoffReason, writeHandoff } from "./handoff";
import { landingTab } from "./next";
import { isOrchestrationTab } from "./orchestration";
import { worktreePath } from "./paths";
import { loadRepoConfig, normalizePrunePath } from "./project-config";
import { defaultDeps, leaveTab, type RemovalDeps, stopApps } from "./remove";
import { entries } from "./sidebar";
import { scaffold } from "./scaffold";
import { type DroppedRepo, getWorkspace, isIceboxed, isRemoving, readState, withState } from "./state";
import { runHooks } from "./hooks";
import { requireTab, TabFocus } from "./tab";
import { errorMessage, fail, log, run } from "./util";

/** The first message of a thawed agent: its resumed conversation reads the handoff `icebox` wrote. */
export const THAW_PROMPT = "/read-handoff";

export interface IceboxDeps extends Pick<RemovalDeps, "mux"> {
  stopApps: (ws: string) => Promise<void>;
  stopChecks: (ws: string) => number;
}

const defaultIceboxDeps = (): IceboxDeps => {
  const { mux } = defaultDeps();
  return { mux, stopApps, stopChecks: stopChecksFor };
};

/** Repos of `ws` holding uncommitted changes or unpushed commits. */
export function unsavedRepos(ws: string): string[] {
  return Object.keys(getWorkspace(readState(), ws).repos).filter((repo) => {
    const wt = worktreePath(ws, repo);
    return existsSync(wt) && (git.isDirty(wt) || git.hasUnpushed(wt));
  });
}

/** Reclaim `icebox` does only when asked: nothing is removed unless its flag is set. */
export interface IceboxOptions {
  /** Delete each repo's configured `icebox.prune` paths. */
  prune?: boolean | undefined;
  /** Remove the worktrees, keeping every claimed branch; `thaw` recreates them. */
  dropWorktree?: boolean | undefined;
}

/** `prunable`'s reason for a configured path that is simply absent; the caller does not log it. */
export const NOT_THERE = "not there";

/** `path` (repo-relative) when it exists, is ignored and untracked by git, and does not leave `wt` through a symlink; else why not. */
export function prunable(wt: string, path: string): { ok: true; abs: string } | { ok: false; why: string } {
  const abs = join(wt, path);
  try {
    lstatSync(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, why: code === "ENOENT" ? NOT_THERE : `cannot stat: ${code}` };
  }
  const base = realpathSync(wt);
  const parent = realpathSync(dirname(abs));
  if (parent !== base && !parent.startsWith(base + sep)) {
    return { ok: false, why: "outside the repo" };
  }
  // check-ignore takes no pathspec magic; `isPrunablePath` already refused the characters that would trigger it
  if (!run(["git", "-C", wt, "check-ignore", "-q", "--", path]).ok) {
    return { ok: false, why: "not ignored by git" };
  }
  const tracked = run(["git", "--literal-pathspecs", "-C", wt, "ls-files", "--", path]);
  if (!tracked.ok || tracked.stdout !== "") {
    return { ok: false, why: tracked.ok ? "tracked by git" : "git could not say whether it is tracked" };
  }
  return { ok: true, abs };
}

/** The configured prune paths of each repo of `ws` that has a worktree; a bad config throws here, before anything changes. */
function prunePaths(ws: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const repo of Object.keys(getWorkspace(readState(), ws).repos)) {
    const wt = worktreePath(ws, repo);
    if (existsSync(wt)) out.set(repo, loadRepoConfig(wt, repo).icebox.prune);
  }
  return out;
}

/** Delete the given prune paths; returns what was removed as `repo/path`. */
function prune(ws: string, paths: Map<string, string[]>): string[] {
  const removed: string[] = [];
  for (const [repo, list] of paths) {
    const wt = worktreePath(ws, repo);
    for (const path of list) {
      const found = prunable(wt, path);
      if (!found.ok) {
        if (found.why !== NOT_THERE) log(`kept ${repo}/${path}: ${found.why}`);
        continue;
      }
      rmSync(found.abs, { recursive: true, force: true });
      removed.push(`${repo}/${path}`);
    }
  }
  return removed;
}

/** Ignored top-level entries of `wt` outside `pruned`: removing the worktree would lose them, and git does not count them as unsaved. */
export function ignoredLeft(wt: string, pruned: string[]): string[] {
  const r = run(["git", "-C", wt, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory"]);
  if (!r.ok) {
    return ["(git could not list the ignored files)"];
  }
  const roots = pruned.map(normalizePrunePath);
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .filter((entry) => !roots.some((root) => entry.replace(/\/$/, "") === root || entry.startsWith(`${root}/`)));
}

/**
 * Pause `ws`: refuse when any repo holds unsaved work, then stop its apps and queued checks, write a handoff, mark it
 * iceboxed in state (claims stay) and close its tab last, since the caller may be running inside it.
 * Returns the handoff path.
 */
export async function icebox(ws: string, opts: IceboxOptions = {}, deps: IceboxDeps = defaultIceboxDeps()): Promise<string> {
  if (isOrchestrationTab(ws)) {
    fail(`${ws} is an orchestration tab; it cannot be iceboxed`);
  }
  const w = getWorkspace(readState(), ws);
  if (isRemoving(w)) {
    fail(`${ws} is being removed`);
  }
  if (isIceboxed(w)) {
    fail(`${ws} is already iceboxed`);
  }
  const unsaved = unsavedRepos(ws);
  if (unsaved.length) {
    fail(`${ws} has uncommitted changes or unpushed commits in ${unsaved.join(", ")}; commit and push first`);
  }
  const paths = opts.prune ? prunePaths(ws) : new Map<string, string[]>();
  if (opts.dropWorktree) {
    const lost = Object.keys(w.repos).flatMap((repo) => {
      const wt = worktreePath(ws, repo);
      return existsSync(wt) ? ignoredLeft(wt, paths.get(repo) ?? []).map((entry) => `${repo}/${entry}`) : [];
    });
    if (lost.length) {
      fail(`${ws}: --drop-worktree would delete ignored files git does not track: ${lost.slice(0, 5).join(", ")}${lost.length > 5 ? ` and ${lost.length - 5} more` : ""}; move them out, or list them in icebox.prune and pass --prune`);
    }
  }
  await deps.stopApps(ws);
  deps.stopChecks(ws);
  const rows = Object.entries(w.repos).map(([repo, c]) => {
    const wt = worktreePath(ws, repo);
    return { repo, branch: c.branch ?? "", head: git.headSha(wt)?.slice(0, 7) ?? "", pr: c.pr };
  });
  const handoff = writeHandoff({ ws, reason: HandoffReason.Icebox, next: `\`overbridge thaw ${ws}\` was run${opts.dropWorktree ? " and recreated the worktrees" : ""}; check each PR and branch, then carry on`, rows });
  withState((s) => {
    const current = getWorkspace(s, ws);
    s.workspaces[ws] = { ...current, iceboxed: { since: new Date().toISOString(), handoff } };
  });
  // the reclaim comes last, after every step that can fail without losing anything; a failure still closes the tab
  let reclaimError: unknown;
  try {
    if (opts.prune) {
      const removed = prune(ws, paths);
      log(removed.length ? `pruned ${removed.join(", ")}` : "nothing to prune");
    }
    if (opts.dropWorktree) {
      dropWorktrees(ws);
    }
  } catch (e) {
    reclaimError = e;
  }
  if (deps.mux.inSession()) {
    const list = entries();
    leaveTab(ws, deps.mux.currentTab() === ws ? landingTab(list, ws) : undefined, deps.mux);
  }
  if (reclaimError !== undefined) {
    fail(`${ws} is iceboxed but not fully reclaimed: ${errorMessage(reclaimError)}`);
  }
  return handoff;
}

/** Remove each worktree of `ws`, recording its branch as dropped as it goes so a failure leaves state true. */
function dropWorktrees(ws: string): void {
  for (const repo of Object.keys(getWorkspace(readState(), ws).repos)) {
    const wt = worktreePath(ws, repo);
    const branch = git.currentBranch(wt);
    if (existsSync(wt)) {
      try {
        git.removeWorktree(getRepo(repo), wt, false);
      } catch (e) {
        fail(`cannot drop ${ws}/${repo}: ${errorMessage(e)}`);
      }
    }
    withState((s) => {
      const current = getWorkspace(s, ws);
      const iceboxed = current.iceboxed ?? fail(`${ws} is no longer iceboxed`);
      s.workspaces[ws] = { ...current, iceboxed: { ...iceboxed, dropped: [...(iceboxed.dropped ?? []), { repo, ...(branch ? { branch } : {}) }] } };
    });
  }
}

/** All-or-nothing: a failure undoes what it created, so the workspace stays iceboxed as it was. */
export function restoreWorktrees(ws: string, dropped: DroppedRepo[]): void {
  const claims = getWorkspace(readState(), ws).repos;
  for (const { repo } of dropped) {
    if (existsSync(worktreePath(ws, repo))) {
      fail(`cannot thaw ${ws}: ${worktreePath(ws, repo)} already exists; move it away first`);
    }
  }
  const made: string[] = [];
  try {
    for (const { repo, branch } of dropped) {
      const spec = getRepo(repo);
      const wt = worktreePath(ws, repo);
      git.addWorktree(spec, wt);
      made.push(repo);
      const target = branch ?? claims[repo]?.branch;
      if (target) git.switchTo(wt, target, `origin/${git.defaultBranch(spec)}`);
    }
  } catch (e) {
    for (const repo of made) {
      try {
        git.removeWorktree(getRepo(repo), worktreePath(ws, repo), true);
      } catch (undo) {
        log(`could not undo ${ws}/${repo}: ${errorMessage(undo)}`);
      }
    }
    fail(`cannot thaw ${ws}: ${errorMessage(e)}`);
  }
}

export interface ThawDeps {
  open: (ws: string, prompt: string) => void;
}

const defaultThawDeps = (): ThawDeps => ({ open: (ws, prompt) => requireTab(ws, prompt, TabFocus.Foreground, undefined, true) });

/** Refuses with the reason, staying iceboxed, when a dropped worktree's folder is taken or its branch cannot be checked out. */
export function thaw(ws: string, deps: ThawDeps = defaultThawDeps()): void {
  const iceboxed = getWorkspace(readState(), ws).iceboxed;
  if (!iceboxed) {
    fail(`${ws} is not iceboxed`);
  }
  const dropped = iceboxed.dropped ?? [];
  restoreWorktrees(ws, dropped);
  withState((s) => {
    const { iceboxed: _, ...rest } = getWorkspace(s, ws);
    s.workspaces[ws] = rest;
  });
  if (dropped.length) {
    scaffold(ws);
    const claims = getWorkspace(readState(), ws).repos;
    for (const { repo } of dropped) {
      const { branch, pr } = claims[repo] ?? {};
      runHooks("post-add", { ws, repo });
      if (branch) runHooks("post-checkout", { ws, repo, branch, ...(pr ? { pr } : {}) });
    }
  }
  deps.open(ws, THAW_PROMPT);
  log(`${ws} thawed`);
}
