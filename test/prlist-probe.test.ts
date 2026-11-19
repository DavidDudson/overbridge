import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { combinedSignature, MAX_PAGE_SIZE, PAGE_HEADROOM, pageSizeFor, parseProbe, probeCommand, readProbe } from "../src/prlist-probe";
import { FULL_MAX_AGE_MS, keepRows, refreshPrList } from "../src/prlist-refresh";
import { readPrList } from "../src/prlist-data";
import type { RunResult } from "../src/util";

const URL_A = "https://github.com/o/r/pull/1";
const URL_B = "https://github.com/o/r/pull/2";
const T1 = "2026-11-11T00:00:00Z";
const T2 = "2026-11-12T00:00:00Z";

const ok = (stdout: string): RunResult => ({ ok: true, code: 0, stdout, stderr: "" });

const probeNode = (url: string, updatedAt: string, state?: string) => ({ url, updatedAt, commits: { nodes: [{ commit: { statusCheckRollup: state ? { state } : null } }] } });

const reply = (nodes: unknown[]) => JSON.stringify({ data: { search: { nodes } } });

describe("probe", () => {
  test("the probe asks for 100 PRs with no review threads or comments", () => {
    const cmd = probeCommand("is:pr author:@me").join(" ");
    expect(cmd).toContain(`first:${MAX_PAGE_SIZE}`);
    expect(cmd).not.toContain("reviewThreads");
    expect(cmd).not.toContain("comments");
    expect(cmd).toContain("q=is:pr author:@me");
  });

  test("the signature changes with the set, an update or the CI rollup, not with the order", () => {
    const base = parseProbe(reply([probeNode(URL_A, T1, "PENDING"), probeNode(URL_B, T1)]));
    expect(base.count).toBe(2);
    expect(parseProbe(reply([probeNode(URL_B, T1), probeNode(URL_A, T1, "PENDING")])).signature).toBe(base.signature);
    expect(parseProbe(reply([probeNode(URL_A, T1, "SUCCESS"), probeNode(URL_B, T1)])).signature).not.toBe(base.signature);
    expect(parseProbe(reply([probeNode(URL_A, T2, "PENDING"), probeNode(URL_B, T1)])).signature).not.toBe(base.signature);
    expect(parseProbe(reply([probeNode(URL_A, T1, "PENDING")])).signature).not.toBe(base.signature);
  });

  test("a node with no URL is not counted", () => {
    expect(parseProbe(reply([{}, null, probeNode(URL_A, T1)])).count).toBe(1);
  });

  test("a reply with no search is the whole call failing, worded from GitHub's error", () => {
    expect(() => parseProbe("nope")).toThrow("GitHub reply was not JSON");
    expect(() => parseProbe(JSON.stringify({ errors: [{ message: "bad query" }] }))).toThrow("bad query");
    expect(() => parseProbe("{}")).toThrow("GitHub reply had no search results");
  });

  test("readProbe names gh's message, or the exit code with none, and reads a partial reply", () => {
    expect(() => readProbe("q", () => ({ ok: false, code: 1, stdout: "", stderr: "API rate limit exceeded\nmore" }))).toThrow("gh api graphql failed: API rate limit exceeded");
    expect(() => readProbe("q", () => ({ ok: false, code: 4, stdout: "", stderr: "" }))).toThrow("exit 4");
    expect(() => readProbe("q", () => ok("{}"))).toThrow("no search results");
    expect(readProbe("q", () => ({ ok: false, code: 1, stdout: reply([probeNode(URL_A, T1)]), stderr: "partial" })).count).toBe(1);
  });

  test("the full read asks for the probe's count plus headroom, at least one and at most a page", () => {
    expect(pageSizeFor(0)).toBe(PAGE_HEADROOM);
    expect(pageSizeFor(22)).toBe(22 + PAGE_HEADROOM);
    expect(pageSizeFor(500)).toBe(MAX_PAGE_SIZE);
    expect(combinedSignature([{ signature: "a", count: 1 }, { signature: "b", count: 1 }])).not.toBe(combinedSignature([{ signature: "ab", count: 1 }]));
  });
});

describe("refreshPrList", () => {
  let tmp: string;
  const savedRoot = process.env.OVERBRIDGE_ROOT;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "overbridge-prlist-"));
    process.env.OVERBRIDGE_ROOT = tmp;
    mkdirSync(join(tmp, ".overbridge"), { recursive: true });
  });

  afterEach(() => {
    if (savedRoot === undefined) delete process.env.OVERBRIDGE_ROOT;
    else process.env.OVERBRIDGE_ROOT = savedRoot;
    rmSync(tmp, { recursive: true, force: true });
  });

  const fullNode = { ...probeNode(URL_A, T1, "SUCCESS"), number: 1, title: "Fix", isDraft: false, repository: { nameWithOwner: "o/r" }, author: { login: "me" } };

  /** A runner that answers the probe and the full read, recording which ran. */
  function github(nodes: () => unknown[]) {
    const calls: string[] = [];

    const runner = (cmd: string[]): RunResult => {
      const query = cmd.find((a) => a.startsWith("query=")) ?? "";

      if (cmd.includes("user")) {
        calls.push("user");

        return ok("me\n");
      }

      calls.push(query.includes("reviewThreads") || query.includes("reviewRequests") ? `full ${/first: ?(\d+)/.exec(query)?.[1]}` : "probe");

      return ok(reply(nodes()));
    };

    return { runner, calls };
  }

  test("an unchanged probe keeps the rows and skips the full read until they are old", () => {
    const { runner, calls } = github(() => [fullNode]);
    const first = refreshPrList("prs", 1_000, runner);
    expect(calls).toEqual(["probe", `full ${1 + PAGE_HEADROOM}`]);
    expect(first.rows.map((r) => r.url)).toEqual([URL_A]);

    const kept = refreshPrList("prs", 61_000, runner);
    expect(calls).toEqual(["probe", `full ${1 + PAGE_HEADROOM}`, "probe"]);
    expect(kept).toMatchObject({ at: 61_000, fullAt: 1_000 });
    expect(readPrList("prs").rows).toHaveLength(1);

    refreshPrList("prs", 1_000 + FULL_MAX_AGE_MS, runner);
    expect(calls.at(-1)).toStartWith("full");
  });

  test("a changed probe, a forced refresh, or a failed last read reads in full", () => {
    let updated = T1;
    const { runner, calls } = github(() => [{ ...fullNode, updatedAt: updated }]);
    refreshPrList("prs", 1_000, runner);
    updated = T2;
    refreshPrList("prs", 2_000, runner);
    expect(calls.filter((c) => c.startsWith("full"))).toHaveLength(2);
    refreshPrList("prs", 3_000, runner, { force: true });
    expect(calls.filter((c) => c.startsWith("full"))).toHaveLength(3);

    const failed = refreshPrList("prs", 4_000, () => ({ ok: false, code: 1, stdout: "", stderr: "offline" }));
    expect(failed).toMatchObject({ error: "gh api graphql failed: offline", rows: [{ url: URL_A }] });
    expect(keepRows(failed, failed.signature ?? "", 4_001)).toBe(false);
    refreshPrList("prs", 5_000, runner);
    expect(calls.at(-1)).toStartWith("full");
    expect(readPrList("prs").error).toBeUndefined();
  });

  test("reviews probe each owner with the signed-in login and size each full search", () => {
    writeFileSync(join(tmp, "config.yml"), "github-orgs: [o, p]\n");
    const { runner, calls } = github(() => [{ ...fullNode, reviewRequests: { nodes: [] } }]);
    const cache = refreshPrList("reviews", 1_000, runner);
    expect(calls).toEqual(["user", "probe", "probe", `full ${1 + PAGE_HEADROOM}`, `full ${1 + PAGE_HEADROOM}`]);
    expect(cache.rows).toHaveLength(1);
  });
});
