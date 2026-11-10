import { existsSync } from "node:fs";
import { stopChecksFor } from "./check-queue";
import * as git from "./git";
import { HandoffReason, writeHandoff } from "./handoff";
import { landingTab } from "./next";
import { isOrchestrationTab } from "./orchestration";
import { worktreePath } from "./paths";
import { defaultDeps, leaveTab, type RemovalDeps, stopApps } from "./remove";
import { currentTab, entries } from "./sidebar";
import { getWorkspace, isIceboxed, isRemoving, readState, withState } from "./state";
import { openTab, TabFocus } from "./tab";
import { fail, log } from "./util";

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

/**
 * Pause `ws`: refuse when any repo holds unsaved work, then stop its apps and queued checks, write a handoff, mark it
 * iceboxed in state (claims and worktrees stay) and close its tab last, since the caller may be running inside it.
 * Returns the handoff path.
 */
export async function icebox(ws: string, deps: IceboxDeps = defaultIceboxDeps()): Promise<string> {
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
  await deps.stopApps(ws);
  deps.stopChecks(ws);
  const rows = Object.entries(w.repos).map(([repo, c]) => {
    const wt = worktreePath(ws, repo);
    return { repo, branch: c.branch ?? "", head: git.headSha(wt)?.slice(0, 7) ?? "", pr: c.pr };
  });
  const handoff = writeHandoff({ ws, reason: HandoffReason.Icebox, next: `\`overbridge thaw ${ws}\` was run; check each PR and branch, then carry on`, rows });
  withState((s) => {
    const current = getWorkspace(s, ws);
    s.workspaces[ws] = { ...current, iceboxed: { since: new Date().toISOString(), handoff } };
  });
  if (deps.inZellij) {
    const list = entries();
    leaveTab(ws, currentTab(deps.exec) === ws ? landingTab(list, ws) : undefined, deps.exec);
  }
  return handoff;
}

export interface ThawDeps {
  open: (ws: string, prompt: string) => void;
}

const defaultThawDeps = (): ThawDeps => ({ open: (ws, prompt) => openTab(ws, prompt, TabFocus.Foreground, undefined, true) });

/** Resume `ws`: clear the iceboxed mark and reopen its tab, the agent continuing its conversation and reading the handoff. */
export function thaw(ws: string, deps: ThawDeps = defaultThawDeps()): void {
  if (!isIceboxed(getWorkspace(readState(), ws))) {
    fail(`${ws} is not iceboxed`);
  }
  withState((s) => {
    const { iceboxed: _, ...rest } = getWorkspace(s, ws);
    s.workspaces[ws] = rest;
  });
  deps.open(ws, THAW_PROMPT);
  log(`${ws} thawed`);
}
