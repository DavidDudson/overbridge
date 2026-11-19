import { describe, expect, test } from "bun:test";
import { bucketOf, CheckBucket, checksReport, parseServedView, prChecks, type PrChecksDeps, type PrChecksTarget, type ServedReply } from "../src/pr-checks";
import type { PrView } from "../src/top";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const PR_URL = "https://github.com/o/r/pull/7";

const view = (over: Partial<PrView> = {}): PrView => ({
  url: PR_URL,
  state: "OPEN",
  headRefOid: HEAD,
  statusCheckRollup: [
    { name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/build" },
    { name: "test", status: "IN_PROGRESS", detailsUrl: "https://ci/test" },
    { context: "policy-bot", state: "PENDING", targetUrl: "https://policy" },
  ],
  ...over,
});

const target: PrChecksTarget = { slug: "o/r", pr: 7, dir: "/wt", head: HEAD };

function fakeDeps(served: ServedReply) {
  const out: string[] = [];
  const err: string[] = [];
  const gh: number[] = [];

  const deps: PrChecksDeps = {
    served: async () => served,
    ghChecks: (pr) => {
      gh.push(pr);

      return 8;
    },
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
  };

  return { deps, out, err, gh };
}

describe("buckets", () => {
  test.each([
    ["SUCCESS", CheckBucket.Pass],
    ["SKIPPED", CheckBucket.Skipping],
    ["NEUTRAL", CheckBucket.Skipping],
    ["FAILURE", CheckBucket.Fail],
    ["TIMED_OUT", CheckBucket.Fail],
    ["STARTUP_FAILURE", CheckBucket.Fail],
    ["CANCELLED", CheckBucket.Cancel],
    ["IN_PROGRESS", CheckBucket.Pending],
    ["EXPECTED", CheckBucket.Pending],
  ])("%s is %s", (state, bucket) => {
    expect(bucketOf(state)).toBe(bucket);
  });
});

describe("checksReport", () => {
  test("a re-run check shows only its newest run", () => {
    const rerun = view({ statusCheckRollup: [
      { name: "build", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-01-01T00:00:00Z" },
      { name: "build", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-01-01T01:00:00Z" },
      { name: "build", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-01-01T00:30:00Z" },
    ] });

    expect(checksReport(rerun, HEAD).rows.map((r) => r.state)).toEqual(["SUCCESS"]);
  });

  test.each([["queued last"], ["queued first"]])("a queued re-run beats an older finished run, %s", (order) => {
    const done = { name: "build", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-01-01T00:00:00Z" };
    const queued = { name: "build", status: "QUEUED" };
    const rollup = order === "queued last" ? [done, queued] : [queued, done];

    expect(checksReport(view({ statusCheckRollup: rollup }), HEAD).rows.map((r) => r.bucket)).toEqual([CheckBucket.Pending]);
  });

  test("rows read like gh pr checks: a run's conclusion once done, else its status; a status's state", () => {
    expect(checksReport(view(), HEAD)).toEqual({
      rows: [
        { name: "build", state: "SUCCESS", bucket: CheckBucket.Pass, link: "https://ci/build" },
        { name: "test", state: "IN_PROGRESS", bucket: CheckBucket.Pending, link: "https://ci/test" },
        { name: "policy-bot", state: "PENDING", bucket: CheckBucket.Pending, link: "https://policy" },
      ],
      notes: [],
    });
  });

  test("an old head adds a pending row, so a poll after a push waits for the new commit", () => {
    const { rows, notes } = checksReport(view({ headRefOid: OLD, statusCheckRollup: [] }), HEAD);
    expect(rows).toEqual([{ name: expect.stringContaining("bbbbbbb is not local HEAD aaaaaaa"), state: "PENDING", bucket: CheckBucket.Pending, link: PR_URL }]);
    expect(notes).toHaveLength(1);
    expect(checksReport(view({ headRefOid: OLD }), undefined).notes).toEqual([]);
  });
});

describe("prChecks", () => {
  test("a PR this worktree does not hold is read from GitHub, never from the batch", async () => {
    const { deps, gh } = fakeDeps({ status: 200, body: JSON.stringify({ view: view() }) });
    const { head: _head, ...other } = target;
    expect(await prChecks(other, deps)).toBe(8);
    expect(gh).toEqual([7]);
  });

  test("no server runs gh pr checks as before", async () => {
    const { deps, gh } = fakeDeps(undefined);
    expect(await prChecks(target, deps)).toBe(8);
    expect(gh).toEqual([7]);
  });

  test("a served view prints the rows as JSON", async () => {
    const { deps, out, err, gh } = fakeDeps({ status: 200, body: JSON.stringify({ view: view() }) });
    expect(await prChecks(target, deps)).toBe(0);
    expect(JSON.parse(out.join(""))).toHaveLength(3);
    expect(err).toEqual([]);
    expect(gh).toEqual([]);
  });

  test("a view served from cache over a failure says so on stderr", async () => {
    const { deps, err } = fakeDeps({ status: 200, body: JSON.stringify({ view: view(), error: "rate limited" }) });
    expect(await prChecks(target, deps)).toBe(0);
    expect(err).toEqual(["served from cache: rate limited"]);
  });

  test("a PR the batch cut short is read from GitHub", async () => {
    const { deps, gh } = fakeDeps({ status: 200, body: "{}" });
    expect(await prChecks(target, deps)).toBe(8);
    expect(gh).toEqual([7]);
  });

  test("a failed read, a missing PR, or no checks yet is exit 1 with the reason", async () => {
    const failed = fakeDeps({ status: 502, body: JSON.stringify({ error: "paused" }) });
    expect(await prChecks(target, failed.deps)).toBe(1);
    expect(failed.err[0]).toContain("reading o/r#7 failed: paused");

    const garbled = fakeDeps({ status: 200, body: "nope" });
    expect(await prChecks(target, garbled.deps)).toBe(1);
    expect(garbled.err[0]).toContain("server answered 200 with a body that is not JSON");

    const gone = fakeDeps({ status: 200, body: JSON.stringify({ view: null }) });
    expect(await prChecks(target, gone.deps)).toBe(1);
    expect(gone.err[0]).toContain("GitHub has no PR o/r#7");

    const none = fakeDeps({ status: 200, body: JSON.stringify({ view: view({ statusCheckRollup: [] }) }) });
    expect(await prChecks(target, none.deps)).toBe(1);
    expect(none.err[0]).toContain("no checks reported on o/r#7 yet");
  });

  test("a reply that is not an object is not a view", () => {
    expect(parseServedView("[]")).toBeUndefined();
    expect(parseServedView(JSON.stringify({ view: 3 }))).toEqual({});
  });
});
