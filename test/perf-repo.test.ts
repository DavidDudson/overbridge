import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandGroup, fileStore, type CheckRecord, redactCommand, summarize, summarizeRepos } from "../src/history";
import { computeViews, pct, percent, repoLines, summaryLines, WINDOWS } from "../src/history-report";
import { loadPerf, PERF_CACHE_MAX_AGE_MS, readPerfCache, refreshPerf, type PerfViews } from "../src/perf-cache";
import { rankedRepos, renderPerf, renderRepos } from "../src/perf-run";
import { createHandler } from "../src/server";

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const run = (over: Partial<CheckRecord>): CheckRecord => ({ kind: "check", at: 10, repo: "app", command: "just check", full: "nix develop --command just check", group: "check", cls: "other", queuedMs: 1000, runMs: 60_000, exit: 0, ...over });

describe("commandGroup", () => {
  test.each([
    ["just check", "check"],
    ["nix develop --command just lint", "lint"],
    ["FOO=1 just --verbose test", "test"],
    ["bun run lint", "lint"],
    ["bun test", "test"],
    ["pnpm typecheck", "typecheck"],
    ["cargo clippy --all", "cargo clippy"],
    ["tsc --noEmit", "tsc"],
  ])("%s -> %s", (command, group) => expect(commandGroup(command)).toBe(group));
});

describe("redactCommand", () => {
  test("keeps the line, blanks env values and secret flags", () => {
    expect(redactCommand("API_TOKEN=abc just check --token xyz --api-key=k --retries=3")).toBe("API_TOKEN=*** just check --token *** --api-key=*** --retries=3");
  });
  test("caps the length", () => {
    expect(redactCommand("x ".repeat(400)).length).toBe(500);
  });
});

describe("exact percentages", () => {
  test("one decimal", () => {
    expect(percent(1, 3)).toBe(33.3);
    expect(pct(124, 1000)).toBe("12.4%");
    expect(pct(0, 0)).toBe("0.0%");
  });
});

describe("repo summaries", () => {
  const records = [run({}), run({ at: 20, runMs: 30_000, exit: 1 }), run({ at: 30, group: "lint", command: "just lint", full: "just lint", runMs: 10_000 }), run({ repo: "lib", runMs: 5000 })];
  test("sum check runs by repo and group, from every workspace", () => {
    const [app, lib] = summarizeRepos(records);
    expect(app).toMatchObject({ repo: "app", count: 3, ms: 100_000, failed: 1 });
    expect(app!.groups.check).toMatchObject({ count: 2, ms: 90_000, failed: 1, fulls: ["nix develop --command just check"] });
    expect(lib).toMatchObject({ repo: "lib", count: 1 });
  });
  test("an old record with no group counts under its label", () => {
    const old: CheckRecord = { kind: "check", at: 1, repo: "r", command: "bun test", cls: "test", queuedMs: 0, runMs: 5, exit: 0 };
    expect(summarize([old]).groups["bun test"]).toMatchObject({ count: 1, fulls: ["bun test"] });
  });
  test("lines give each group's exact share and its full command", () => {
    const text = repoLines(rankedRepos(summarizeRepos(records))[0]!).join("\n");
    expect(text).toContain("check");
    expect(text).toContain("90.0%");
    expect(text).toContain("nix develop --command just check");
    expect(summaryLines({ ws: "w", summary: summarize(records) }).join("\n")).toContain("check    check 3× 1m35s (90.5%)");
  });
  test("renders rows, the groups, the full command, and says so when empty", () => {
    const rows = renderRepos(rankedRepos(summarizeRepos(records)), 0, 0, 20, 120, "7d").map(strip);
    expect(rows[0]).toContain("Performance by repo · 7d");
    expect(rows.some((r) => r.includes("app") && r.includes("1m40s"))).toBe(true);
    expect(rows.some((r) => r.includes("check 2× 1m30s 90.0%"))).toBe(true);
    expect(rows.some((r) => r.includes("command nix develop --command just check"))).toBe(true);
    expect(rows.length).toBe(20);
    expect(renderRepos([], 0, 0, 12, 80, "1h").map(strip).join("\n")).toContain("no check runs yet");
  });
  test("the workspace view shows percentages with a decimal", () => {
    const rows = renderPerf([{ ws: "w", summary: summarize(records) }], 0, 0, 20, 120, "24h").map(strip);
    expect(rows.some((r) => /\d+\.\d%/.test(r))).toBe(true);
  });
});

describe("windows and the cache", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ob-perf-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("offers 1h, 24h, 7d and all", () => expect(WINDOWS.map((w) => w.label)).toEqual(["1h", "24h", "7d", "all"]));

  test("computeViews splits each window by workspace and repo", () => {
    const store = fileStore(dir);
    const now = 10 * 24 * 3600_000;
    store.append("a", run({ at: now - 1000, runMs: 5 }));
    store.append("b", run({ at: now - 2 * 24 * 3600_000, runMs: 7 }));
    store.append("b", run({ at: 1, runMs: 9, repo: "old" }));
    const v = computeViews(store, now);
    expect(Object.keys(v)).toEqual(["1h", "24h", "7d", "all"]);
    expect(v["24h"]!.repos.map((r) => [r.repo, r.count])).toEqual([["app", 1]]);
    expect(v["7d"]!.repos.map((r) => [r.repo, r.count])).toEqual([["app", 2]]);
    expect(v.all!.repos.map((r) => r.repo).sort()).toEqual(["app", "old"]);
    expect(v["7d"]!.workspaces.map((w) => w.ws)).toEqual(["a", "b"]);
  });

  test("refreshPerf writes the file readPerfCache reads; loadPerf prefers it while young, else computes", () => {
    const store = fileStore(dir);
    store.append("a", run({ at: 5 }));
    const file = join(dir, "perf.json");
    const written = refreshPerf(store, 1000, file);
    expect(readPerfCache(file)).toEqual(written);
    let computed = 0;
    const compute = (): PerfViews => ({ at: 0, windows: (computed++, {}) });
    expect(loadPerf({ read: () => written, compute, now: 1000 + PERF_CACHE_MAX_AGE_MS - 1 })).toBe(written);
    loadPerf({ read: () => written, compute, now: 1000 + PERF_CACHE_MAX_AGE_MS });
    loadPerf({ read: () => undefined, compute });
    expect(computed).toBe(2);
    writeFileSync(file, "{nope");
    expect(readPerfCache(file)).toBeUndefined();
  });

  test("the server rebuilds the views once inside the window, on demand", async () => {
    let built = 0;
    let t = 0;
    const h = createHandler({
      refreshTop: async () => { throw new Error("unused"); },
      refreshPerf: async () => ++built,
      workspaceExists: () => false,
      cacheFileAt: () => 0,
      version: "v1",
      onVersionMismatch: () => undefined,
      now: () => t,
    });
    const post = (path: string) => h.handle(new Request(`http://x${path}`, { method: "POST" }));
    await Promise.all([post("/refresh/perf"), post("/refresh/perf")]);
    expect(built).toBe(1);
    t = 1000;
    await post("/refresh/perf");
    expect(built).toBe(1);
    expect((await post("/refresh/perf?force=1")).status).toBe(200);
    expect(built).toBe(2);
    expect((await post("/refresh/perf?async=1")).status).toBe(202);
  });
});
