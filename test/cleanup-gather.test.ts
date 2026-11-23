import { describe, expect, test } from "bun:test";
import { gatherFacts, type GatherDeps, namedItem, type Target } from "../src/cleanup-gather";
import { classify, CleanupReason, CleanupVerdict, PrState } from "../src/cleanup-scan";
import { ItemStatus } from "../src/pm/provider";
import type { Claim } from "../src/state";
import type { RunResult } from "../src/util";
import { fakeProvider } from "./helpers/fake-provider";

const WT = "/w/ENG-1/app";
const ok = (stdout = ""): RunResult => ({ ok: true, code: 0, stdout, stderr: "" });
const failed = (stderr = "boom"): RunResult => ({ ok: false, code: 1, stdout: "", stderr });

type Replies = Record<string, RunResult>;

/** Replies keyed by the start of the command line; the longest matching key wins, and an unknown command fails. */
function fakeDeps(replies: Replies, over: Partial<GatherDeps> = {}) {
  const calls: string[] = [];
  const keys = Object.keys(replies).toSorted((a, b) => b.length - a.length);

  const deps: GatherDeps = {
    exec: (cmd) => {
      const line = cmd.join(" ");
      calls.push(line);
      const key = keys.find((k) => line.startsWith(k));

      return key ? replies[key]! : failed(`unexpected: ${line}`);
    },
    provider: () => fakeProvider([{ id: "ENG-1", title: "One", url: "" }, { id: "ENG-2", title: "Two", url: "" }], "jira", ["ENG-2"]),
    defaultRef: () => "origin/main",
    agent: () => "idle",
    stacked: () => false,
    strayFiles: () => [],
    ...over,
  };

  return { deps, calls };
}

const GIT = `git -C ${WT}`;

/** A clean worktree on `branch`, `ahead` commits past main, all of them on a remote. */
const cleanGit = (branch: string, ahead = 0) => ({
  [`${GIT} branch --show-current`]: ok(branch),
  [`${GIT} status --porcelain`]: ok(),
  [`${GIT} rev-list --count origin/main..HEAD`]: ok(String(ahead)),
  [`${GIT} rev-list --count HEAD --not --remotes`]: ok("0"),
  [`${GIT} rev-parse HEAD`]: ok("abc123"),
  [`${GIT} stash list`]: ok(),
}) satisfies Replies;

/** A REST pull as `gh api repos/{owner}/{repo}/pulls/<n>` prints it: a merged PR is `closed` with a `merged_at`. */
const prJson = (number: number, state: PrState, ref: string, title = "") => ({
  number,
  state: state === PrState.Open ? "open" : "closed",
  merged_at: state === PrState.Merged ? "2026-11-10T00:00:00Z" : null,
  head: { ref },
  html_url: `https://gh.test/pull/${number}`,
  title,
});

const PULLS = "gh api repos/{owner}/{repo}/pulls";
const pullKey = (n: number) => `${PULLS}/${n}`;
const pull = (n: number, state: PrState, ref: string, title = "") => ({ [pullKey(n)]: ok(JSON.stringify(prJson(n, state, ref, title))) });
const branchKey = (branch: string) => `${PULLS}?head={owner}:${encodeURIComponent(branch)}&state=all`;
const searchKey = (id: string) => `gh api search/issues?q=repo:{owner}/{repo}+is:pr+${id}&`;
const searched = (id: string, ...numbers: number[]) => ({ [searchKey(id)]: ok(JSON.stringify({ items: numbers.map((number) => ({ number })) })) });

const target = (ws: string, branch?: string, pr?: number): Target => {
  const claim: Claim = {};

  if (branch) claim.branch = branch;

  if (pr) claim.pr = pr;

  return { ws, orphan: false, repos: [{ repo: "app", wt: WT, claim }] };
};

describe("namedItem", () => {
  test("a jira workspace is named for its ticket", () => {
    expect(namedItem("ENG-12", "app", fakeProvider([], "jira"))).toBe("ENG-12");
  });

  test("a github workspace is named gh-<repo>-<number>", () => {
    expect(namedItem("gh-app-12", "app", fakeProvider())).toBe("12");
  });

  test("a task workspace names no item", () => {
    expect(namedItem("workspace-cleanup-skill", "app", fakeProvider())).toBeUndefined();
    expect(namedItem("spike-2", "app", fakeProvider())).toBeUndefined();
  });
});

describe("gatherFacts", () => {
  test("reads the recorded PR by number and skips the item search once it has merged", () => {
    const { deps, calls } = fakeDeps({ ...cleanGit("feat/ENG-1-x", 2), ...pull(7, PrState.Merged, "feat/ENG-1-x") });
    const facts = gatherFacts(target("ENG-1", "feat/ENG-1-x", 7), deps);
    expect(facts.repos[0]!.pr).toEqual({ number: 7, state: PrState.Merged, branch: "feat/ENG-1-x", url: "https://gh.test/pull/7", item: "ENG-1" });
    expect(facts.item).toEqual({ id: "ENG-1", status: ItemStatus.Open });
    expect(calls.some((c) => c.startsWith("gh api search"))).toBe(false);
    expect(classify(facts).reason).toBe(CleanupReason.Merged);
  });

  test("finds the item's merged PR on another branch when none was recorded", () => {
    const { deps } = fakeDeps({
      ...cleanGit("feat/ENG-1-x"),
      [branchKey("feat/ENG-1-x")]: ok("[]"),
      ...searched("ENG-1", 9, 10),
      ...pull(9, PrState.Merged, "fix/ENG-1-renamed"),
      ...pull(10, PrState.Open, "feat/ENG-100-unrelated", "mentions ENG-1 in passing"),
    });

    const facts = gatherFacts(target("ENG-1", "feat/ENG-1-x"), deps);
    expect(facts.repos[0]!.itemPrs.map((pr) => pr.number)).toEqual([9]);
    expect(facts.problems).toEqual([]);
    expect(classify(facts).reason).toBe(CleanupReason.MergedByItem);
  });

  test("commits on no remote branch are saved when HEAD is in a merged PR", () => {
    const git = { ...cleanGit("feat/ENG-1-x", 3), [`${GIT} rev-list --count HEAD --not --remotes`]: ok("3") };
    const pr = { ...pull(7, PrState.Merged, "feat/ENG-1-x") };
    const squashed = fakeDeps({ ...git, ...pr, "gh api repos/{owner}/{repo}/commits/abc123/pulls": ok(JSON.stringify([{ merged_at: "2026-11-10T00:00:00Z" }])) });
    expect(gatherFacts(target("ENG-1", "feat/ENG-1-x", 7), squashed.deps).repos[0]!.unpushed).toBe(false);
    const local = fakeDeps({ ...git, ...pr, "gh api repos/{owner}/{repo}/commits/abc123/pulls": ok(JSON.stringify([{ merged_at: null }])) });
    expect(gatherFacts(target("ENG-1", "feat/ENG-1-x", 7), local.deps).repos[0]!.unpushed).toBe(true);
    const offline = fakeDeps({ ...git, ...pr });
    expect(classify(gatherFacts(target("ENG-1", "feat/ENG-1-x", 7), offline.deps)).verdict).toBe(CleanupVerdict.Review);
  });

  test("counts only the stashes made on this branch", () => {
    const stashes = ["WIP on feat/ENG-1-x: abc one", "On feat/ENG-1-x: named", "WIP on feat/ENG-1-xy: other branch", "WIP on main: def"].join("\n");
    const { deps } = fakeDeps({ ...cleanGit("feat/ENG-1-x"), [`${GIT} stash list`]: ok(stashes), ...pull(7, PrState.Merged, "feat/ENG-1-x") });
    expect(gatherFacts(target("ENG-1", "feat/ENG-1-x", 7), deps).repos[0]!.stashes).toBe(2);
  });

  test("a detached workspace named for a done item, with nothing claimed", () => {
    const git = { ...cleanGit("", 3), [`${GIT} rev-list --count HEAD --not --remotes`]: ok("3"), "gh api repos/{owner}/{repo}/commits/abc123/pulls": ok(JSON.stringify([{ merged_at: "2026-11-10T00:00:00Z" }])) };
    const { deps } = fakeDeps({ ...git, ...searched("ENG-2") });
    const facts = gatherFacts(target("ENG-2"), deps);
    expect(facts.named).toEqual({ id: "ENG-2", status: ItemStatus.Done });
    expect(facts.item).toBeUndefined();
    expect(classify(facts)).toMatchObject({ verdict: CleanupVerdict.Remove, reason: CleanupReason.ItemDone });
  });

  test("a workspace named for a done item that holds another item's open PR", () => {
    const { deps } = fakeDeps({ ...cleanGit("feat/ENG-1-x", 2), ...pull(3290, PrState.Open, "feat/ENG-1-x"), ...searched("ENG-1") });
    expect(classify(gatherFacts(target("ENG-2", "feat/ENG-1-x", 3290), deps))).toMatchObject({ verdict: CleanupVerdict.Rebind, reason: CleanupReason.HoldsOtherItem });
  });

  test("a recorded PR that cannot be read keeps the workspace", () => {
    const { deps } = fakeDeps({ ...cleanGit("feat/ENG-1-x"), [pullKey(7)]: failed("HTTP 502"), ...searched("ENG-1") });
    const found = classify(gatherFacts(target("ENG-1", "feat/ENG-1-x", 7), deps));
    expect(found.problems).toEqual(["PR #7 could not be read: HTTP 502"]);
    expect(found).toMatchObject({ verdict: CleanupVerdict.Keep, reason: CleanupReason.Unreadable });
  });

  test("a worktree git cannot read counts as unpushed work", () => {
    const { deps } = fakeDeps({ ...pull(7, PrState.Merged, "feat/ENG-1-x") });
    const facts = gatherFacts(target("ENG-1", "feat/ENG-1-x", 7), deps);
    expect(facts.repos[0]).toMatchObject({ dirty: true, unpushed: true });
    expect(classify(facts).verdict).toBe(CleanupVerdict.Keep);
  });

  test("a repo with no provider still gets its git and PR facts", () => {
    const { deps } = fakeDeps({ ...cleanGit("task/spike"), [branchKey("task/spike")]: failed() }, { provider: () => undefined });
    const facts = gatherFacts(target("spike", "task/spike"), deps);
    expect(facts.item).toBeUndefined();
    expect(facts.repos[0]).toMatchObject({ task: true, ahead: 0, itemPrs: [] });
    expect(classify(facts)).toMatchObject({ verdict: CleanupVerdict.Remove, reason: CleanupReason.TaskIdle });
  });

  test("a branch's open PR wins over an older closed one", () => {
    const listed = [prJson(5, PrState.Closed, "feat/ENG-1-x"), prJson(6, PrState.Open, "feat/ENG-1-x")];
    const { deps } = fakeDeps({ ...cleanGit("feat/ENG-1-x"), [branchKey("feat/ENG-1-x")]: ok(JSON.stringify(listed)), ...searched("ENG-1") });
    expect(gatherFacts(target("ENG-1", "feat/ENG-1-x"), deps).repos[0]!.pr).toMatchObject({ number: 6, state: PrState.Open });
  });

  test("a search hit that cannot be read keeps the workspace", () => {
    const { deps } = fakeDeps({ ...cleanGit("feat/ENG-1-x"), [branchKey("feat/ENG-1-x")]: ok("[]"), ...searched("ENG-1", 9), [pullKey(9)]: failed("HTTP 502") });
    const found = classify(gatherFacts(target("ENG-1", "feat/ENG-1-x"), deps));
    expect(found.problems).toEqual(["PR #9 could not be read: HTTP 502"]);
    expect(found.reason).toBe(CleanupReason.Unreadable);
  });

  test("a failed search keeps the workspace", () => {
    const { deps } = fakeDeps({ ...cleanGit("feat/ENG-1-x"), [branchKey("feat/ENG-1-x")]: ok("[]"), [searchKey("ENG-1")]: failed("HTTP 403") });
    expect(classify(gatherFacts(target("ENG-1", "feat/ENG-1-x"), deps)).problems).toEqual(["PRs for ENG-1 could not be listed: HTTP 403"]);
  });

  test("an empty GraphQL budget leaves no workspace unreadable: every PR read goes through REST", () => {
    const graphqlLimited = failed("GraphQL: API rate limit already exceeded for user ID 1.");

    const { deps, calls } = fakeDeps({
      "gh pr": graphqlLimited,
      "gh api graphql": graphqlLimited,
      ...cleanGit("feat/ENG-1-x", 2),
      ...pull(7, PrState.Open, "feat/ENG-1-x"),
      ...searched("ENG-1", 7),
    });

    const findings = [target("ENG-1", "feat/ENG-1-x", 7), target("ENG-2", "feat/ENG-1-x", 7)].map((t) => classify(gatherFacts(t, deps)));
    expect(findings.map((f) => f.reason)).not.toContain(CleanupReason.Unreadable);
    expect(findings.flatMap((f) => f.problems)).toEqual([]);
    expect(calls.filter((c) => c.startsWith("gh ") && !c.startsWith("gh api repos/") && !c.startsWith("gh api search/"))).toEqual([]);
  });

  test("a session mid-turn is not at rest", () => {
    const { deps } = fakeDeps({ ...cleanGit("task/spike"), [branchKey("task/spike")]: failed() }, { provider: () => undefined, agent: () => "busy" });
    expect(gatherFacts(target("spike", "task/spike"), deps)).toMatchObject({ agent: "busy", agentAtRest: false });
  });
});
