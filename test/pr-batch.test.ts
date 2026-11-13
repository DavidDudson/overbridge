import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBatchQuery, type GhRun, mapPr, parseBatch, PrBatcher } from "../src/pr-batch";
import { ownerRepo } from "../src/server-prs";
import { withState } from "../src/state";
import { claimedPrs, prefetchFor } from "../src/server-prs";
import { refreshTop } from "../src/top";
import { fakeProvider } from "./helpers/fake-provider";

const URL = "https://github.com/o/r/pull/3";
const REVIEW = { author: { login: "copilot-pull-request-reviewer" }, state: "COMMENTED", submittedAt: "2026-06-01T10:00:00Z", url: `${URL}#r1` };
const RABBIT = { author: { login: "coderabbitai" }, body: "summary", createdAt: "2026-06-01T09:00:00Z", url: `${URL}#c1` };
const CHECK = { name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/1" };
const STATUS = { context: "coderabbitai", state: "SUCCESS", targetUrl: "https://rabbit/1" };

/** What `gh pr view --json ...` prints for the PR, and what the threads query prints. */
const viewJson = JSON.stringify({
  url: URL,
  title: "Add dark mode",
  isDraft: false,
  updatedAt: "2026-06-01T11:00:00Z",
  state: "OPEN",
  headRefOid: "abc",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  statusCheckRollup: [{ __typename: "CheckRun", ...CHECK }, { __typename: "StatusContext", ...STATUS }],
  reviewRequests: [{ __typename: "Bot", login: "copilot-pull-request-reviewer" }],
  latestReviews: [REVIEW],
  comments: [RABBIT],
});
const threadsJson = JSON.stringify({
  data: { repository: { pullRequest: { reviewThreads: { nodes: [
    { isResolved: false, comments: { nodes: [{ author: { login: "coderabbitai" } }] } },
    { isResolved: true, comments: { nodes: [{ author: { login: "coderabbitai" } }] } },
    { isResolved: false, comments: { nodes: [{ author: { login: "someone" } }] } },
  ] } } } },
});

/** The same PR as one node of the batched reply. */
const node = {
  url: URL,
  title: "Add dark mode",
  isDraft: false,
  updatedAt: "2026-06-01T11:00:00Z",
  state: "OPEN",
  headRefOid: "abc",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewRequests: { nodes: [{ requestedReviewer: { __typename: "Bot", login: "copilot-pull-request-reviewer" } }] },
  latestReviews: { nodes: [REVIEW] },
  comments: { nodes: [RABBIT] },
  reviewThreads: { nodes: JSON.parse(threadsJson).data.repository.pullRequest.reviewThreads.nodes },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", ...CHECK }, { __typename: "StatusContext", ...STATUS }] } } } }] },
};
const reply = (prs: Record<number, unknown>, cost = 1) => JSON.stringify({ data: { rateLimit: { cost }, repository: Object.fromEntries(Object.entries(prs).map(([n, v]) => [`p${n}`, v])) } });

describe("PR batch mapping", () => {
  test("query aliases every PR and names the cost", () => {
    const q = buildBatchQuery([3, 9]);
    expect(q).toContain("p3:pullRequest(number:3){...F}");
    expect(q).toContain("p9:pullRequest(number:9){...F}");
    expect(q).toContain("rateLimit{cost");
  });

  test("a PR with no commit rollup maps to no checks", () => {
    expect(mapPr({ ...node, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }).statusCheckRollup).toEqual([]);
  });

  test("Team and deleted-user reviewers", () => {
    const m = mapPr({ ...node, reviewRequests: { nodes: [{ requestedReviewer: { __typename: "Team", name: "core" } }, { requestedReviewer: null }] } });
    expect(m.reviewRequests).toEqual([{ name: "core" }]);
  });

  test("a non-NOT_FOUND error on one PR fails the call instead of reading as a missing PR", () => {
    const body = JSON.stringify({ data: { repository: { p3: null } }, errors: [{ type: "RESOURCE_LIMITS_EXCEEDED", path: ["repository", "p3"], message: "timeout" }] });
    expect(() => parseBatch(body, [3])).toThrow("timeout");
  });

  test("a deleted PR is null and the call still reads; a reply with no repository fails", () => {
    const r = parseBatch(JSON.stringify({ data: { repository: { p3: null, p4: node } }, errors: [{ type: "NOT_FOUND", path: ["repository", "p3"] }] }), [3, 4]);
    expect(r.prs[3]).toBeNull();
    expect(r.prs[4]?.url).toBe(URL);
    expect(() => parseBatch(JSON.stringify({ errors: [{ message: "Bad credentials" }] }), [3])).toThrow("Bad credentials");
    expect(() => parseBatch("oops", [3])).toThrow("not JSON");
  });

  test("owner/repo from ssh and https remotes", () => {
    expect(ownerRepo("git@github.com:o/r.git")).toBe("o/r");
    expect(ownerRepo("https://github.com/o/r")).toBe("o/r");
    expect(ownerRepo("git@gitlab.com:o/r.git")).toBeUndefined();
  });
});

describe("refreshTop from a batched reply", () => {
  let tmp: string;
  const saved = process.env.OVERBRIDGE_ROOT;
  const items = [{ id: "12", title: "Add dark mode", url: "x" }];
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-prb-")));
    process.env.OVERBRIDGE_ROOT = tmp;
    for (const ws of ["w1", "w2"]) {
      mkdirSync(join(tmp, ws, "r"), { recursive: true });
      writeFileSync(join(tmp, ws, "r", "overbridge.yml"), "version: 1\nproject-management:\n  name: github\n  project: o/r\n");
    }
    withState((s) => {
      s.workspaces.w1 = { created: "now", repos: { r: { branch: "feat/12-dark-mode", pr: 3 } } };
      s.workspaces.w2 = { created: "now", repos: { r: { branch: "feat/13-other", pr: 4 } } };
    });
  });
  afterEach(() => {
    saved === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = saved);
    rmSync(tmp, { recursive: true, force: true });
  });
  const strip = ({ at: _at, ...rest }: { at: number }) => rest;

  test("top cache is identical to the per-PR path's for the same PR", () => {
    const perPr = refreshTop("w1", {
      provider: () => fakeProvider(items),
      exec: (cmd) => (cmd[1] === "api" ? threadsJson : viewJson),
    });
    const batched = refreshTop("w1", {
      provider: () => fakeProvider(items),
      exec: () => {
        throw new Error("no gh call expected");
      },
      prefetched: { r: { prs: { 3: mapPr(node) } } },
    });
    expect(JSON.stringify(strip(batched))).toBe(JSON.stringify(strip(perPr)));
    // the fixture exercises a comment count and a reviewer: guard against an empty comparison
    expect(batched.links[1]!.pr!.reviewers).toEqual([
      { name: "Copilot", state: "reviewed", url: `${URL}#r1` },
      { name: "CodeRabbit", state: "comments", detail: "1", url: "https://rabbit/1" },
    ]);
  });

  test("a PR missing from the reply is a problem for that workspace only", () => {
    const prefetched = { r: { prs: { 3: mapPr(node), 4: null } } };
    const run = (ws: string) => refreshTop(ws, { provider: () => fakeProvider(items), exec: () => undefined, prefetched });
    expect(run("w1").message).toBeUndefined();
    expect(run("w2").message).toBe("r: no URL for PR #4");
  });

  test("a PR the reply did not ask for is read directly; stale prs carry the refetch error", () => {
    const asked: string[] = [];
    const cache = refreshTop("w1", { provider: () => fakeProvider(items), exec: (cmd) => { asked.push(cmd.join(" ")); return cmd[1] === "api" ? threadsJson : viewJson; }, prefetched: { r: { prs: {}, error: "HTTP 502" } } });
    expect(asked.some((c) => c.startsWith("gh pr view 3"))).toBe(true);
    expect(cache.message).toBe("r: HTTP 502");
  });

  test("a failed batch with no earlier reply reads the PR directly", () => {
    const cache = refreshTop("w1", { provider: () => fakeProvider(items), exec: (cmd) => (cmd[1] === "api" ? threadsJson : viewJson), prefetched: { r: { error: "rate limited" } } });
    expect(cache.message).toBeUndefined();
    expect(cache.links[1]!.url).toBe(URL);
  });

  test("a PR cut short by the 100-node connection cap is read directly, not counted short", () => {
    const cut = parseBatch(JSON.stringify({ data: { repository: { p3: { ...node, reviewThreads: { ...node.reviewThreads, pageInfo: { hasNextPage: true } } } } } }), [3]);
    expect(cut.prs[3]).toBeUndefined();
    expect(3 in cut.prs).toBe(true);
  });
});

describe("PrBatcher", () => {
  const fakeRun = (log: string[][]): GhRun => async (args) => {
    log.push(args);
    const numbers = [...args.join(" ").matchAll(/pullRequest\(number:(\d+)\)/g)].map((m) => Number(m[1]));
    return { stdout: reply(Object.fromEntries(numbers.map((n) => [n, node])), 2), stderr: "", code: 0 };
  };

  test("10 workspaces on one repo asking together cause one call", async () => {
    const calls: string[][] = [];
    const b = new PrBatcher({ run: fakeRun(calls), sleep: () => Promise.resolve() });
    const got = await Promise.all(Array.from({ length: 10 }, (_, i) => b.get("o/r", [100 + i])));
    expect(calls).toHaveLength(1);
    for (const g of got) expect(Object.keys(g.prs)).toHaveLength(10);
    expect(b.stats()).toMatchObject({ calls: 1, prs: 10, points: 2 });
    // inside the TTL the next window costs nothing
    await b.get("o/r", [103]);
    expect(calls).toHaveLength(1);
  });

  test("one call reads every claimed PR of the repo, so workspaces arriving later hit the cache", async () => {
    const calls: string[][] = [];
    const b = new PrBatcher({ run: fakeRun(calls), sleep: () => Promise.resolve(), claimed: () => [1, 2, 3, 4, 5] });
    await b.get("o/r", [1]);
    const later = await b.get("o/r", [5]);
    expect(calls).toHaveLength(1);
    expect(later.prs[5]).toBeTruthy();
  });

  test("more PRs than the query holds are paged", async () => {
    const calls: string[][] = [];
    const b = new PrBatcher({ run: fakeRun(calls), sleep: () => Promise.resolve(), perQuery: 20, claimed: () => Array.from({ length: 45 }, (_, i) => i + 1) });
    const { prs } = await b.get("o/r", [1]);
    expect(calls).toHaveLength(3);
    expect(Object.keys(prs)).toHaveLength(45);
  });

  test("repos do not share a call", async () => {
    const calls: string[][] = [];
    const b = new PrBatcher({ run: fakeRun(calls), sleep: () => Promise.resolve() });
    await Promise.all([b.get("o/a", [1]), b.get("o/b", [1])]);
    expect(calls).toHaveLength(2);
  });

  test("a PR opened after the last read triggers one more call", async () => {
    const calls: string[][] = [];
    const b = new PrBatcher({ run: fakeRun(calls), sleep: () => Promise.resolve() });
    await b.get("o/r", [1]);
    const g = await b.get("o/r", [1, 2]);
    expect(calls).toHaveLength(2);
    expect(g.prs[2]).toBeTruthy();
  });

  test("a failed call rejects with nothing cached, and serves the old reply once one exists", async () => {
    let fail = true;
    const b = new PrBatcher({ sleep: () => Promise.resolve(), run: async (a) => (fail ? { stdout: "", stderr: "HTTP 502", code: 1 } : fakeRun([])(a)) });
    await expect(b.get("o/r", [1])).rejects.toThrow("not JSON: HTTP 502");
    fail = false;
    // the failed key is backing off: wait it out by forcing
    expect((await b.get("o/r", [1], { force: true })).prs[1]).toBeTruthy();
    fail = true;
    const stale = await b.get("o/r", [1], { force: true });
    expect(stale.prs[1]).toBeTruthy();
    expect(stale.error).toContain("502");
  });
});

describe("prefetchFor and claimedPrs", () => {
  let tmp: string;
  const saved = process.env.OVERBRIDGE_ROOT;
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-prf-")));
    process.env.OVERBRIDGE_ROOT = tmp;
    writeFileSync(join(tmp, "repos.toml"), '[repos.gh]\nurl = "git@github.com:o/r.git"\n[repos.lab]\nurl = "git@gitlab.com:o/x.git"\n');
    // a stack of PRs 7, 8, 9 in repo gh
    mkdirSync(join(tmp, ".bare", "gh.git"), { recursive: true });
    const layer = (branch: string, n: number) => ({ branch, pullRequest: { number: n } });
    writeFileSync(join(tmp, ".bare", "gh.git", "gh-stack"), JSON.stringify({ stacks: [{ trunk: { branch: "main" }, branches: [layer("a", 7), layer("b", 8), layer("c", 9)] }] }));
    withState((s) => {
      s.workspaces.w1 = { created: "now", repos: { gh: { branch: "b", pr: 8 }, lab: { branch: "x", pr: 1 } } };
      s.workspaces.w2 = { created: "now", repos: { gh: { branch: "feat", pr: 3 } } };
      s.workspaces.w3 = { created: "now", repos: { gh: { branch: "feat3", pr: 3 } } };
    });
  });
  afterEach(() => {
    saved === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = saved);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("claimedPrs is the union across workspaces, with every layer of a stack, and skips non-GitHub repos", () => {
    expect(claimedPrs("o/r").sort((a, b) => a - b)).toEqual([3, 7, 8, 9]);
  });

  test("prefetchFor leaves a non-GitHub repo out, passes force, and turns a failure into that repo's error", async () => {
    const seen: { repo: string; numbers: number[]; force?: boolean }[] = [];
    const batcher = { get: async (repo: string, numbers: number[], o: { force?: boolean }) => (seen.push({ repo, numbers, force: o.force }), { prs: { 8: null } as Record<number, null> }) };
    const ok = await prefetchFor("w1", batcher as unknown as PrBatcher, { force: true });
    expect(Object.keys(ok)).toEqual(["gh"]);
    expect(seen).toEqual([{ repo: "o/r", numbers: [8, 7, 9], force: true }]);
    const bad = await prefetchFor("w1", { get: async () => { throw new Error("down"); } } as unknown as PrBatcher);
    expect(bad).toEqual({ gh: { error: "down" } });
  });
});
