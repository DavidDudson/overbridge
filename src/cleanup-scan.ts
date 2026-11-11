/**
 * The pure half of `overbridge cleanup`: what one workspace's facts (read by `cleanup-gather.ts`) say to do with it.
 * Nothing here removes anything; the `cleanup` skill asks the user and runs `overbridge rm`.
 */
import type { AgentState } from "./agent-state";
import { ItemStatus } from "./pm/provider";

/** What the scan says to do with a workspace. */
export const CleanupVerdict = {
  /** Finished and holds nothing unsaved: safe to remove once the user confirms. */
  Remove: "remove",
  /** Finished, but something in it would be lost: the user looks first. */
  Review: "review",
  /** Named for a finished item while it holds another item's open PR: move the PR, don't remove. */
  Rebind: "rebind",
  /** Nothing was ever done here and its item is still open: only the user knows whether it is wanted. */
  Ask: "ask",
  Keep: "keep",
} as const;
export type CleanupVerdict = (typeof CleanupVerdict)[keyof typeof CleanupVerdict];

/** Why a workspace got its verdict. */
export const CleanupReason = {
  /** Every claimed branch's recorded PR has merged. */
  Merged: "merged",
  /** A claimed branch has no merged PR recorded, but a PR found by the item's id has merged. */
  MergedByItem: "merged-by-item",
  /** The item is done and no PR is open. */
  ItemDone: "item-done",
  /** A task branch with no PR and no commits, and its session is at rest. */
  TaskIdle: "task-idle",
  /** A folder with worktrees that state does not know. */
  Orphan: "orphan",
  /** The workspace's own item is done, and it holds an open PR for a different item. */
  HoldsOtherItem: "holds-other-item",
  /** No PR, no commits, nothing unsaved, session at rest, item not done. */
  NeverStarted: "never-started",
  InProgress: "in-progress",
  /** A read failed, so nothing can be said about it. */
  Unreadable: "unreadable",
} as const;
export type CleanupReason = (typeof CleanupReason)[keyof typeof CleanupReason];

/** What would be lost, or cut off, by removing a workspace. */
export const CleanupBlocker = {
  Uncommitted: "uncommitted",
  /** Commits on no remote branch and in no merged PR. */
  Unpushed: "unpushed",
  Stash: "stash",
  /** Files in the workspace folder that overbridge did not generate and no worktree holds. */
  StrayFiles: "stray-files",
  SessionActive: "session-active",
} as const;
export type CleanupBlocker = (typeof CleanupBlocker)[keyof typeof CleanupBlocker];

export const PrState = { Open: "open", Merged: "merged", Closed: "closed" } as const;
export type PrState = (typeof PrState)[keyof typeof PrState];

export interface PrFact {
  number: number;
  state: PrState;
  /** The PR's head branch. */
  branch: string;
  url: string;
  /** The item the PR's branch or title names. */
  item?: string;
}

export interface RepoFacts {
  repo: string;
  /** The claimed branch. */
  claim?: string;
  /** The checked-out branch; unset when detached. */
  head?: string;
  /** The claim is a task branch: work started with no item. */
  task: boolean;
  /** The claim is a layer of a gh stack with more than one layer. */
  stacked: boolean;
  dirty: boolean;
  /** Commits on HEAD that the default branch does not have. */
  ahead: number;
  /** HEAD holds commits that are on no remote branch and in no merged PR. */
  unpushed: boolean;
  /** Stash entries made on this worktree's branch. */
  stashes: number;
  /** The claim's PR: the recorded one, else the one GitHub has for the claimed branch. */
  pr?: PrFact;
  /** Other PRs that name the workspace's item. */
  itemPrs: PrFact[];
}

export interface ItemFact {
  id: string;
  status?: ItemStatus;
}

export interface WorkspaceFacts {
  ws: string;
  /** A folder on disk that state does not list. */
  orphan: boolean;
  repos: RepoFacts[];
  /** The item the claimed branch names. */
  item?: ItemFact;
  /** The item the workspace's name stands for. */
  named?: ItemFact;
  agent?: AgentState;
  /** No turn is in progress in the workspace's session. */
  agentAtRest: boolean;
  strayFiles: string[];
  /** Reads that failed. A failed read never makes a workspace look finished. */
  problems: string[];
}

export interface Blocker {
  kind: CleanupBlocker;
  repo?: string;
  detail?: string;
}

export interface Finding extends WorkspaceFacts {
  verdict: CleanupVerdict;
  reason: CleanupReason;
  blockers: Blocker[];
  /** A sentence for the report. */
  summary: string;
}

const repoBlockers = (r: RepoFacts): Blocker[] => [
  ...(r.dirty ? [{ kind: CleanupBlocker.Uncommitted, repo: r.repo }] : []),
  ...(r.unpushed ? [{ kind: CleanupBlocker.Unpushed, repo: r.repo, detail: `${r.ahead} ahead of the default branch` }] : []),
  ...(r.stashes ? [{ kind: CleanupBlocker.Stash, repo: r.repo, detail: `${r.stashes} on ${r.head ?? r.claim}` }] : []),
];

/** Everything in `f` that removing it would lose or cut off. */
export function blockersOf(f: WorkspaceFacts): Blocker[] {
  return [
    ...f.repos.flatMap(repoBlockers),
    ...(f.strayFiles.length ? [{ kind: CleanupBlocker.StrayFiles, detail: f.strayFiles.join(", ") }] : []),
    ...(f.agentAtRest ? [] : [{ kind: CleanupBlocker.SessionActive, detail: f.agent }]),
  ];
}

const prsOf = (r: RepoFacts): PrFact[] => [...(r.pr ? [r.pr] : []), ...r.itemPrs];
const isDone = (item: ItemFact | undefined) => item?.status === ItemStatus.Done;

/** An open PR for an item other than the finished one the workspace is named for. */
function otherItemPr(f: WorkspaceFacts): PrFact | undefined {
  if (!isDone(f.named)) {
    return undefined;
  }
  return f.repos.flatMap((r) => (r.pr ? [r.pr] : [])).find((pr) => pr.state === PrState.Open && pr.item !== undefined && pr.item !== f.named?.id);
}

/** Why `f` is finished, or undefined when it is not. */
function finishedReason(f: WorkspaceFacts): CleanupReason | undefined {
  const claimed = f.repos.filter((r) => r.claim);
  // a stack's other layers may still be open, and the scan reads one PR per claim
  if (!f.repos.length || f.repos.some((r) => r.stacked)) {
    return undefined;
  }
  if (claimed.length && claimed.every((r) => r.pr?.state === PrState.Merged)) {
    return CleanupReason.Merged;
  }
  if (f.repos.some((r) => prsOf(r).some((pr) => pr.state === PrState.Open))) {
    return undefined;
  }
  if (claimed.length && claimed.every((r) => prsOf(r).some((pr) => pr.state === PrState.Merged))) {
    return CleanupReason.MergedByItem;
  }
  if (isDone(f.item) || (!f.item && isDone(f.named))) {
    return CleanupReason.ItemDone;
  }
  const idleTask = claimed.length > 0 && claimed.every((r) => r.task && !prsOf(r).length) && f.repos.every((r) => r.ahead === 0) && f.agentAtRest;
  return idleTask ? CleanupReason.TaskIdle : undefined;
}

const neverStarted = (f: WorkspaceFacts): boolean =>
  f.repos.length > 0 && f.repos.every((r) => !r.stacked && r.ahead === 0 && !prsOf(r).length);

const SUMMARY: Record<CleanupReason, (f: WorkspaceFacts) => string> = {
  [CleanupReason.Merged]: () => "every claimed PR has merged",
  [CleanupReason.MergedByItem]: (f) => `a PR for ${(f.item ?? f.named)?.id ?? "its item"} merged from another branch, so none was recorded here`,
  [CleanupReason.ItemDone]: (f) => `${(f.item ?? f.named)?.id} is done and no PR is open`,
  [CleanupReason.TaskIdle]: () => "task branch with no PR and no commits, session at rest",
  [CleanupReason.Orphan]: () => "folder on disk that overbridge does not track",
  [CleanupReason.HoldsOtherItem]: (f) => {
    const pr = otherItemPr(f);
    return `${f.named?.id} is done, but the workspace holds ${pr?.item}'s open PR #${pr?.number}`;
  },
  [CleanupReason.NeverStarted]: (f) => `no commits and no PR${(f.item ?? f.named) ? `; ${(f.item ?? f.named)?.id} is not done` : ""}`,
  [CleanupReason.InProgress]: () => "work in progress",
  [CleanupReason.Unreadable]: (f) => `could not be read: ${f.problems.join("; ")}`,
};

/** Decide one workspace. Unsaved work or a running session turns a removal into a review, never the other way round. */
export function classify(f: WorkspaceFacts): Finding {
  const blockers = blockersOf(f);
  const found = (verdict: CleanupVerdict, reason: CleanupReason): Finding => ({ ...f, verdict, reason, blockers, summary: SUMMARY[reason](f) });
  const removeOrReview = (reason: CleanupReason) => found(blockers.length ? CleanupVerdict.Review : CleanupVerdict.Remove, reason);
  if (f.problems.length) {
    return found(CleanupVerdict.Keep, CleanupReason.Unreadable);
  }
  if (f.orphan) {
    return removeOrReview(CleanupReason.Orphan);
  }
  if (otherItemPr(f)) {
    return found(CleanupVerdict.Rebind, CleanupReason.HoldsOtherItem);
  }
  const reason = finishedReason(f);
  if (reason) {
    return removeOrReview(reason);
  }
  if (neverStarted(f) && !blockers.length) {
    return found(CleanupVerdict.Ask, CleanupReason.NeverStarted);
  }
  return found(CleanupVerdict.Keep, CleanupReason.InProgress);
}
