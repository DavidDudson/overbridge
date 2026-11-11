import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { stopChecksFor } from "./check-queue";
import { getRepo } from "./config";
import * as git from "./git";
import { HandoffReason, writeHandoff } from "./handoff";
import { landingTab } from "./next";
import { isOrchestrationTab } from "./orchestration";
import { worktreePath } from "./paths";
import { loadRepoConfig } from "./project-config";
import { defaultDeps, leaveTab, type RemovalDeps, stopApps } from "./remove";
import { currentTab, entries } from "./sidebar";
import { getWorkspace, isIceboxed, isRemoving, readState, withState } from "./state";
import { runHooks } from "./hooks";
import { openTab, TabFocus } from "./tab";
import { errorMessage, fail, log, run } from "./util";

/** The first message of a thawed agent: its resumed conversation reads the handoff `icebox` wrote. */
export const THAW_PROMPT = "/read-handoff";

export interface IceboxDeps extends Pick<RemovalDeps, "exec" | "inZellij"> {
  stopApps: (ws: string) => Promise<void>;
  stopChecks: (ws: string) => number;
}

const defaultIceboxDeps = (): IceboxDeps => {
  const { exec, inZellij } = defaultDeps();
  return { exec, inZellij, stopApps, stopChecks: stopChecksFor };
};

/** Repos of `ws` holding uncommitted changes or unpushed commits. */
export function unsavedRepos(ws: string): string[] {
  return Object.keys(getWorkspace(readState(), ws).repos).filter((repo) => {
    const wt = worktreePath(ws, repo);
    return existsSync(wt) && (git.isDirty(wt) || git.hasUnpushed(wt));
  });
}

/** Disk and slot reclaim `icebox` does only when asked: nothing is removed unless its flag is set. */
export interface IceboxOptions {
  /** Delete each repo's configured `icebox.prune` paths that git does not track. */
  prune?: boolean | undefined;
  /** Remove the worktrees, keeping every claimed branch; `thaw` recreates them. */
  dropWorktree?: boolean | undefined;
}

/** `path` (repo-relative) inside `wt` when it exists, is not tracked by git and does not leave `wt` through a symlink; else why not. */
export function prunable(wt: string, path: string): { ok: true; abs: string } | { ok: false; why: string } {
  const abs = join(wt, path);
  try {
    lstatSync(abs);
  } catch {
    return { ok: false, why: "not there" };
  }
  const base = realpathSync(wt);
  const parent = realpathSync(dirname(abs));
  if (parent !== base && !parent.startsWith(base + sep)) {
    return { ok: false, why: "outside the repo" };
  }
  const tracked = run(["git", "-C", wt, "ls-files", "--", path]);
  if (!tracked.ok || tracked.stdout !== "") {
    return { ok: false, why: tracked.ok ? "tracked by git" : "git could not say whether it is tracked" };
  }
  return { ok: true, abs };
}

/** Delete the configured prune paths of every repo of `ws`; returns what was removed as `repo/path`. */
export function pruneWorkspace(ws: string): string[] {
  const removed: string[] = [];
  for (const repo of Object.keys(getWorkspace(readState(), ws).repos)) {
    const wt = worktreePath(ws, repo);
    if (!existsSync(wt)) {
      continue;
    }
    for (const path of loadRepoConfig(wt, repo).icebox.prune) {
      const found = prunable(wt, path);
      if (!found.ok) {
        if (found.why !== "not there") log(`kept ${repo}/${path}: ${found.why}`);
        continue;
      }
      rmSync(found.abs, { recursive: true, force: true });
      removed.push(`${repo}/${path}`);
    }
  }
  return removed;
}

/**
 * Pause `ws`: refuse when any repo holds unsaved work, then stop its apps and queued checks, write a handoff, mark it
 * iceboxed in state (claims stay) and close its tab last, since the caller may be running inside it. `opts.prune`
 * deletes configured build artifacts and `opts.dropWorktree` removes the worktrees, both before the tab closes.
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
  if (opts.prune) {
    // read every repo's config first, so a bad one refuses before anything is stopped or deleted
    for (const repo of Object.keys(w.repos)) {
      const wt = worktreePath(ws, repo);
      if (existsSync(wt)) loadRepoConfig(wt, repo);
    }
  }
  await deps.stopApps(ws);
  deps.stopChecks(ws);
  if (opts.prune) {
    const removed = pruneWorkspace(ws);
    log(removed.length ? `pruned ${removed.join(", ")}` : "nothing to prune");
  }
  const rows = Object.entries(w.repos).map(([repo, c]) => {
    const wt = worktreePath(ws, repo);
    return { repo, branch: c.branch ?? "", head: git.headSha(wt)?.slice(0, 7) ?? "", pr: c.pr };
  });
  const handoff = writeHandoff({ ws, reason: HandoffReason.Icebox, next: `\`overbridge thaw ${ws}\` was run${opts.dropWorktree ? " and recreated the worktrees" : ""}; check each PR and branch, then carry on`, rows });
  withState((s) => {
    const current = getWorkspace(s, ws);
    s.workspaces[ws] = { ...current, iceboxed: { since: new Date().toISOString(), handoff } };
  });
  if (opts.dropWorktree) {
    dropWorktrees(ws);
  }
  if (deps.inZellij) {
    const list = entries();
    leaveTab(ws, currentTab(deps.exec) === ws ? landingTab(list, ws) : undefined, deps.exec);
  }
  return handoff;
}

/** Remove each worktree of `ws` (clean and pushed, checked by `icebox`), recording each as dropped as it goes so a failure leaves state true. */
function dropWorktrees(ws: string): void {
  for (const repo of Object.keys(getWorkspace(readState(), ws).repos)) {
    const wt = worktreePath(ws, repo);
    if (existsSync(wt)) {
      git.removeWorktree(getRepo(repo), wt, false);
    }
    withState((s) => {
      const current = getWorkspace(s, ws);
      s.workspaces[ws] = { ...current, iceboxed: { ...current.iceboxed!, dropped: [...(current.iceboxed?.dropped ?? []), repo] } };
    });
  }
}

/**
 * Recreate the dropped worktrees of `ws` on their claimed branches. Checks every folder is free first and undoes
 * what it made when one repo fails, so a refused thaw leaves the workspace iceboxed as it was.
 */
export function restoreWorktrees(ws: string, repos: string[]): void {
  const claims = getWorkspace(readState(), ws).repos;
  for (const repo of repos) {
    if (existsSync(worktreePath(ws, repo))) {
      fail(`cannot thaw ${ws}: ${worktreePath(ws, repo)} already exists; move it away first`);
    }
  }
  const made: string[] = [];
  try {
    for (const repo of repos) {
      const spec = getRepo(repo);
      const wt = worktreePath(ws, repo);
      git.addWorktree(spec, wt);
      made.push(repo);
      const branch = claims[repo]?.branch;
      if (branch) git.switchTo(wt, branch, `origin/${git.defaultBranch(spec)}`);
    }
  } catch (e) {
    for (const repo of made) git.removeWorktree(getRepo(repo), worktreePath(ws, repo), true);
    fail(`cannot thaw ${ws}: ${errorMessage(e)}`);
  }
}

export interface ThawDeps {
  open: (ws: string, prompt: string) => void;
}

const defaultThawDeps = (): ThawDeps => ({ open: (ws, prompt) => openTab(ws, prompt, TabFocus.Foreground, undefined, true) });

/**
 * Resume `ws`: recreate any dropped worktrees, clear the iceboxed mark and reopen its tab, the agent continuing its
 * conversation and reading the handoff. The workspace keeps its name; a taken folder or an unusable branch refuses with the reason.
 */
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
  for (const repo of dropped) {
    const branch = getWorkspace(readState(), ws).repos[repo]?.branch;
    runHooks("post-add", { ws, repo });
    if (branch) runHooks("post-checkout", { ws, repo, branch });
  }
  deps.open(ws, THAW_PROMPT);
  log(`${ws} thawed`);
}
