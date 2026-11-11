import { describe, expect, test } from "bun:test";
import { classify, CleanupBlocker, CleanupReason, CleanupVerdict, type PrFact, PrState, type RepoFacts, type WorkspaceFacts } from "../src/cleanup-scan";
import { ItemStatus } from "../src/pm/provider";

const pr = (number: number, state: PrState, item = "ENG-1", branch = `feat/${item}-x`): PrFact => ({ number, state, branch, url: `https://gh.test/pull/${number}`, item });

const repo = (over: Partial<RepoFacts> = {}): RepoFacts => ({
  repo: "app",
  claim: "feat/ENG-1-x",
  head: "feat/ENG-1-x",
  task: false,
  stacked: false,
  dirty: false,
  ahead: 2,
  unpushed: false,
  stashes: 0,
  itemPrs: [],
  ...over,
});

const facts = (over: Partial<WorkspaceFacts> = {}): WorkspaceFacts => ({
  ws: "ENG-1",
  orphan: false,
  repos: [repo()],
  item: { id: "ENG-1", status: ItemStatus.Open },
  named: { id: "ENG-1", status: ItemStatus.Open },
  agentAtRest: true,
  strayFiles: [],
  problems: [],
  ...over,
});

const detached = (over: Partial<RepoFacts> = {}) => {
  const { claim: _claim, head: _head, ...rest } = repo({ ahead: 0, ...over });
  return rest;
};

const verdictOf = (f: WorkspaceFacts) => {
  const found = classify(f);
  return [found.verdict, found.reason];
};

describe("classify: finished workspaces", () => {
  test("recorded PR merged, sweep not yet run", () => {
    expect(verdictOf(facts({ repos: [repo({ pr: pr(7, PrState.Merged) })] }))).toEqual([CleanupVerdict.Remove, CleanupReason.Merged]);
  });

  test("every claimed repo needs a merged PR", () => {
    const repos = [repo({ pr: pr(7, PrState.Merged) }), repo({ repo: "api", pr: pr(8, PrState.Open) })];
    expect(verdictOf(facts({ repos }))).toEqual([CleanupVerdict.Keep, CleanupReason.InProgress]);
  });

  test("no PR recorded, but the item's PR merged from another branch", () => {
    const repos = [repo({ itemPrs: [pr(9, PrState.Merged, "ENG-1", "fix/ENG-1-other-name")] })];
    expect(verdictOf(facts({ repos }))).toEqual([CleanupVerdict.Remove, CleanupReason.MergedByItem]);
  });

  test("an open PR for the item keeps it, even beside a merged one", () => {
    const repos = [repo({ itemPrs: [pr(9, PrState.Merged), pr(10, PrState.Open)] })];
    expect(verdictOf(facts({ repos }))).toEqual([CleanupVerdict.Keep, CleanupReason.InProgress]);
  });

  test("item done, detached on another merged PR's commits", () => {
    const f = facts({ repos: [detached({ ahead: 3 })], item: undefined, named: { id: "ENG-1", status: ItemStatus.Done } });
    expect(verdictOf(f)).toEqual([CleanupVerdict.Remove, CleanupReason.ItemDone]);
  });

  test("a closed PR alone does not finish a workspace", () => {
    expect(verdictOf(facts({ repos: [repo({ pr: pr(7, PrState.Closed) })] }))).toEqual([CleanupVerdict.Keep, CleanupReason.InProgress]);
  });

  test("task branch with no PR and no commits, session at rest", () => {
    const f = facts({ ws: "spike", repos: [repo({ claim: "task/spike", head: "task/spike", task: true, ahead: 0 })], item: undefined, named: undefined });
    expect(verdictOf(f)).toEqual([CleanupVerdict.Remove, CleanupReason.TaskIdle]);
  });

  test("task branch with commits is work in progress", () => {
    const f = facts({ ws: "spike", repos: [repo({ claim: "task/spike", task: true, ahead: 1 })], item: undefined, named: undefined });
    expect(verdictOf(f)).toEqual([CleanupVerdict.Keep, CleanupReason.InProgress]);
  });

  test("task branch with a busy session is kept", () => {
    const f = facts({ ws: "spike", repos: [repo({ claim: "task/spike", task: true, ahead: 0 })], item: undefined, named: undefined, agent: "busy", agentAtRest: false });
    expect(verdictOf(f)).toEqual([CleanupVerdict.Keep, CleanupReason.InProgress]);
  });

  test("a stacked claim is never finished by one layer's PR", () => {
    expect(verdictOf(facts({ repos: [repo({ stacked: true, pr: pr(7, PrState.Merged) })] }))).toEqual([CleanupVerdict.Keep, CleanupReason.InProgress]);
  });

  test("a workspace with no repos is kept", () => {
    expect(verdictOf(facts({ repos: [], item: undefined, named: { id: "ENG-1", status: ItemStatus.Done } }))).toEqual([CleanupVerdict.Keep, CleanupReason.InProgress]);
  });
});

describe("classify: unsaved work turns a removal into a review", () => {
  const merged = { pr: pr(7, PrState.Merged) };

  test.each([
    ["uncommitted changes", { repos: [repo({ ...merged, dirty: true })] }, CleanupBlocker.Uncommitted],
    ["unpushed commits", { repos: [repo({ ...merged, unpushed: true })] }, CleanupBlocker.Unpushed],
    ["a stash", { repos: [repo({ ...merged, stashes: 1 })] }, CleanupBlocker.Stash],
    ["stray files", { repos: [repo(merged)], strayFiles: ["notes.md"] }, CleanupBlocker.StrayFiles],
    ["a session mid-turn", { repos: [repo(merged)], agent: "busy" as const, agentAtRest: false }, CleanupBlocker.SessionActive],
  ])("%s", (_name, over, blocker) => {
    const found = classify(facts(over));
    expect(found.verdict).toBe(CleanupVerdict.Review);
    expect(found.reason).toBe(CleanupReason.Merged);
    expect(found.blockers.map((b) => b.kind)).toEqual([blocker]);
  });

  test("a blocker names its repo", () => {
    const found = classify(facts({ repos: [repo(merged), repo({ ...merged, repo: "api", dirty: true })] }));
    expect(found.blockers).toEqual([{ kind: CleanupBlocker.Uncommitted, repo: "api" }]);
  });
});

describe("classify: orphans", () => {
  test("a clean orphan can go", () => {
    const f = facts({ orphan: true, repos: [detached()], item: undefined });
    expect(verdictOf(f)).toEqual([CleanupVerdict.Remove, CleanupReason.Orphan]);
  });

  test("an orphan with unsaved work is reviewed first", () => {
    const f = facts({ orphan: true, repos: [detached({ dirty: true })], item: undefined });
    expect(verdictOf(f)).toEqual([CleanupVerdict.Review, CleanupReason.Orphan]);
  });
});

describe("classify: rebind and ask", () => {
  test("named for a done item while holding another item's open PR", () => {
    const f = facts({
      ws: "ENG-2",
      repos: [repo({ claim: "feat/ENG-1-x", pr: pr(3290, PrState.Open, "ENG-1") })],
      item: { id: "ENG-1", status: ItemStatus.Open },
      named: { id: "ENG-2", status: ItemStatus.Done },
    });
    const found = classify(f);
    expect([found.verdict, found.reason]).toEqual([CleanupVerdict.Rebind, CleanupReason.HoldsOtherItem]);
    expect(found.summary).toBe("ENG-2 is done, but the workspace holds ENG-1's open PR #3290");
  });

  test("an open PR for the workspace's own done item is not a rebind", () => {
    const f = facts({ repos: [repo({ pr: pr(7, PrState.Open) })], item: { id: "ENG-1", status: ItemStatus.Done }, named: { id: "ENG-1", status: ItemStatus.Done } });
    expect(verdictOf(f)).toEqual([CleanupVerdict.Keep, CleanupReason.InProgress]);
  });

  test("detached on the default branch, clean, item still open: never started", () => {
    const f = facts({ repos: [detached()], item: undefined });
    expect(verdictOf(f)).toEqual([CleanupVerdict.Ask, CleanupReason.NeverStarted]);
  });

  test("never started but dirty is work in progress", () => {
    const f = facts({ repos: [detached({ dirty: true })], item: undefined });
    expect(verdictOf(f)).toEqual([CleanupVerdict.Keep, CleanupReason.InProgress]);
  });
});

describe("classify: failed reads", () => {
  test("a workspace with a failed read is kept, whatever else it looks like", () => {
    const found = classify(facts({ repos: [repo({ pr: pr(7, PrState.Merged) })], problems: ["PR #7 could not be read: timeout"] }));
    expect([found.verdict, found.reason]).toEqual([CleanupVerdict.Keep, CleanupReason.Unreadable]);
    expect(found.summary).toContain("timeout");
  });
});
