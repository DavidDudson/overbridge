import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBatchQuery, type GhRun, mapPr, parseBatch, PrBatcher } from "../src/pr-batch";
import { ownerRepo } from "../src/server-prs";
import { withState } from "../src/state";
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

  test("a deleted PR is null and the call still reads; a reply with no repository fails", () => {
    const r = parseBatch(JSON.stringify({ data: { repository: { p3: null, p4: node } }, errors: [{ type: "NOT_FOUND" }] }), [3, 4]);
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

  test("a failed batch is that repo's problem, with no per-PR gh call", () => {
    const cache = refreshTop("w1", { provider: () => fakeProvider(items), exec: () => { throw new Error("no gh call expected"); }, prefetched: { r: { error: "rate limited" } } });
    expect(cache.message).toContain("r: rate limited");
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
