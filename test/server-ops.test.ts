import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrBatcher } from "../src/pr-batch";
import { DEFAULT_PAUSE_MS, isRateLimited, MAX_PAUSE_MS, MIN_PAUSE_MS, RateGate } from "../src/rate-limit";
import { createHandler } from "../src/server";
import { Cache } from "../src/server-cache";
import { formatStatus, keyRows, type ServerStatus } from "../src/server-cmd";
import { startWatchdog, watchdogVerdict } from "../src/server-watchdog";

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("rate limit gate", () => {
  test("recognises what gh and GraphQL print for a limit", () => {
    for (const t of ["gh: API rate limit exceeded for user ID 1 (HTTP 403)", "You have exceeded a secondary rate limit", `{"errors":[{"type":"RATE_LIMITED"}]}`]) expect(isRateLimited(t)).toBe(true);
    for (const t of ["could not resolve to a PullRequest", "rateLimit{cost remaining}", "timed out"]) expect(isRateLimited(t)).toBe(false);
  });

  test("a limit pauses gh until the default, then until the reset GitHub reports", async () => {
    let t = 1_000_000;
    const gate = new RateGate({ now: () => t, lookupReset: async () => t + 20 * 60_000 });
    expect(gate.message()).toBeUndefined();
    expect(gate.observe("gh: API rate limit exceeded")).toBe(true);
    expect(gate.message()).toContain("gh calls paused until");
    expect(gate.stats()).toMatchObject({ paused: true, trips: 1, untilMs: t + DEFAULT_PAUSE_MS });
    await settle();
    expect(gate.stats().untilMs).toBe(t + 20 * 60_000);
    t += 20 * 60_000 - 1;
    expect(gate.message()).toBeDefined();
    t += 1;
    expect(gate.message()).toBeUndefined();
    expect(gate.stats().paused).toBe(false);
  });

  test("a reset that is too near is stretched, one too far is cut, an unreadable one keeps the default", async () => {
    const at = async (reset: number | undefined) => {
      const gate = new RateGate({ now: () => 0, lookupReset: async () => reset });
      gate.observe("rate limit exceeded");
      await settle();
      return gate.stats().untilMs;
    };
    expect(await at(1_000)).toBe(MIN_PAUSE_MS);
    expect(await at(10 * 3_600_000)).toBe(MAX_PAUSE_MS);
    expect(await at(undefined)).toBe(DEFAULT_PAUSE_MS);
  });

  test("another failure during a pause does not count as a new trip", () => {
    const gate = new RateGate({ now: () => 0 });
    gate.observe("API rate limit exceeded");
    gate.observe("API rate limit exceeded");
    expect(gate.stats().trips).toBe(1);
  });

  test("a failure that is not a limit changes nothing", () => {
    const gate = new RateGate();
    expect(gate.observe("network is unreachable")).toBe(false);
    expect(gate.message()).toBeUndefined();
  });

  test("simulated rate-limit reply: the batcher stops calling gh until the reset and serves its last reply", async () => {
    let t = 0;
    let calls = 0;
    let limited = false;
    const gate = new RateGate({ now: () => t });
    const pr = { number: 1, url: "u", title: "t", isDraft: false, updatedAt: "2026-01-01T00:00:00Z", state: "OPEN", headRefOid: "a", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", statusCheckRollup: { contexts: { nodes: [] } }, reviewRequests: { nodes: [] }, latestReviews: { nodes: [] }, comments: { nodes: [] }, reviewThreads: { nodes: [] } };
    const reply = JSON.stringify({ data: { rateLimit: { cost: 1 }, repository: { p1: pr } } });
    const batcher = new PrBatcher({
      now: () => t,
      sleep: async () => undefined,
      paused: () => gate.message(),
      onError: (_k, e) => gate.observe(e.message),
      run: async () => {
        calls++;
        return limited ? { stdout: "", stderr: "gh: API rate limit exceeded for user ID 1 (HTTP 403)", code: 1 } : { stdout: reply, stderr: "", code: 0 };
      },
    });
    const first = await batcher.get("o/r", [1], { force: true });
    expect(first.prs[1]).toBeTruthy();
    expect(calls).toBe(1);

    limited = true;
    t += 61_000;
    const hit = await batcher.get("o/r", [1]);
    expect(calls).toBe(2);
    expect(hit.error).toContain("rate limit");
    expect(hit.prs[1]).toBeTruthy();
    expect(gate.message()).toContain("paused");

    // paused: more refreshes, forced ones too, make no gh call and still serve the last reply, naming the pause
    t += 5_000;
    for (const force of [false, true, true]) {
      const got = await batcher.get("o/r", [1], { force });
      // an unforced call is answered from the error backoff (the failure's own text); a forced one reaches the pause
      expect(got.error).toMatch(force ? /GitHub rate limit reached/ : /rate limit/);
      expect(got.prs[1]).toBeTruthy();
    }
    expect(calls).toBe(2);

    // past the reset gh is called again
    limited = false;
    t += DEFAULT_PAUSE_MS + 1;
    const after = await batcher.get("o/r", [1], { force: true });
    expect(calls).toBe(3);
    expect(after.error).toBeUndefined();
  });
});

describe("per-key counters", () => {
  test("hits, misses, in flight and the last error are kept per key", async () => {
    const t = 0;
    const cache = new Cache<number>({ now: () => t, backoffBaseMs: 1 });
    const opts = { ttlMs: 100, staleMs: 1000 };
    await cache.get("a", async () => 1, opts);
    await cache.get("a", async () => 1, opts);
    await cache.get("a", async () => 1, opts);
    await cache
      .get(
        "b",
        async () => {
          throw new Error("boom");
        },
        opts,
      )
      .catch(() => undefined);
    let release = () => {};
    const slow = cache.get("b", () => new Promise<number>((r) => (release = () => r(2))), { ...opts, force: true });
    await settle();
    expect(cache.stats().keys.b).toMatchObject({ inFlight: true, lastError: "boom", lastErrorAtMs: 0, failures: 1 });
    release();
    await slow;
    expect(cache.stats().keys.a).toMatchObject({ hits: 2, misses: 1, inFlight: false });
    // the last error outlives the success that cleared `error`
    expect(cache.stats().keys.b).toMatchObject({ misses: 2, inFlight: false, lastError: "boom", failures: 0 });
    expect(cache.stats().keys.b!.error).toBeUndefined();
  });
});

describe("server status", () => {
  const status: ServerStatus = {
    version: "abc",
    pid: 42,
    uptimeMs: 3_725_000,
    subscribers: 2,
    hits: 5,
    misses: 3,
    shared: 1,
    fetches: 3,
    inFlight: 1,
    queued: 0,
    keys: { "top:w1": { hits: 4, misses: 2, inFlight: true, atMs: 90_000 } },
    perf: { keys: { perf: { hits: 1, misses: 1, inFlight: false } } },
    prBatch: { calls: 2, prs: 8, points: 9, cache: { keys: { "gh:prs:o/r": { hits: 0, misses: 2, inFlight: false, lastError: "boom", lastErrorAtMs: 80_000 } } } },
    sweep: { runs: 3, lastAt: 60_000 },
    rateLimit: { paused: true, message: "GitHub rate limit reached: gh calls paused until 14:32:10, showing cached data" },
  };

  test("prints uptime, the rate-limit pause and every key's counters", () => {
    const text = formatStatus(status, 100_000);
    expect(text).toContain("up 1h 2m");
    expect(text).toContain("subscribers 2");
    expect(text).toContain("gh: GitHub rate limit reached");
    expect(text).toMatch(/top:w1 +hits 4 +misses 2 +in flight/);
    expect(text).toContain("last error 20s ago: boom");
    expect(text).toContain("pr batch: 2 calls, 8 PRs, 9 points");
  });

  test("keys from every cache are listed once, sorted", () => {
    expect(keyRows(status).map(([k]) => k)).toEqual(["gh:prs:o/r", "perf", "top:w1"]);
  });

  test("GET /status carries the rate limit and the keys", async () => {
    const h = createHandler({ refreshTop: async () => ({}) as never, refreshPerf: async () => 0, workspaceExists: () => true, cacheFileAt: () => 0, version: "v", onVersionMismatch: () => undefined, rateStats: () => ({ paused: false, trips: 0 }) });
    const body = (await (await h.handle(new Request("http://x/status"))).json()) as ServerStatus;
    expect(body.rateLimit).toEqual({ paused: false, trips: 0 });
    expect(body.keys).toEqual({});
  });
});

describe("watchdog", () => {
  test("a stale heartbeat is a hang; a late check is a sleep, not a hang", () => {
    const base = { hungMs: 30_000, checkMs: 5_000 };
    expect(watchdogVerdict({ ...base, beatMs: 0, nowMs: 10_000, lastCheckMs: 5_000 })).toBe("ok");
    expect(watchdogVerdict({ ...base, beatMs: 0, nowMs: 30_000, lastCheckMs: 25_000 })).toBe("hung");
    expect(watchdogVerdict({ ...base, beatMs: 0, nowMs: 3_600_000, lastCheckMs: 100_000 })).toBe("slept");
  });

  test("a server that stops beating is killed and its replacement started", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ob-wd-")));
    const marker = join(dir, "restarted");
    const victim = Bun.spawn({ cmd: ["sleep", "60"], stdout: "ignore", stderr: "ignore" });
    const stop = startWatchdog({ pid: victim.pid, restart: ["touch", marker], hungMs: 300, checkMs: 50, heartbeat: false });
    const code = await Promise.race([victim.exited, Bun.sleep(5_000).then(() => "alive")]);
    expect(code).not.toBe("alive");
    expect(victim.signalCode).toBe("SIGKILL");
    for (let i = 0; i < 50 && !existsSync(marker); i++) await Bun.sleep(20);
    expect(existsSync(marker)).toBe(true);
    stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a server that keeps beating is left alone", async () => {
    const victim = Bun.spawn({ cmd: ["sleep", "60"], stdout: "ignore", stderr: "ignore" });
    const stop = startWatchdog({ pid: victim.pid, restart: ["true"], hungMs: 1_500, checkMs: 50 });
    await Bun.sleep(400);
    expect(victim.exitCode).toBeNull();
    stop();
    victim.kill();
  });
});

describe("overbridge server", () => {
  const CLI = join(import.meta.dir, "..", "src", "cli.ts");
  const cli = async (root: string, ...args: string[]) => {
    const p = Bun.spawn({ cmd: [process.execPath, CLI, "server", ...args], env: { ...process.env, OVERBRIDGE_ROOT: root, OVERBRIDGE_SELF: `${process.execPath} ${CLI}`, OVERBRIDGE_NAME: "" }, stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return { out, code };
  };

  test("status says none is running; restart starts one, status lists its keys, stop ends it", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ob-srvcmd-")));
    try {
      mkdirSync(join(root, ".overbridge"), { recursive: true });
      writeFileSync(join(root, ".overbridge", "state.json"), JSON.stringify({ version: 1, workspaces: { w1: { created: "", repos: {} } } }));
      expect(await cli(root, "status")).toEqual({ out: "server not running\n", code: 1 });
      expect((await cli(root, "stop")).out).toBe("server not running\n");

      const restarted = await cli(root, "restart");
      expect(restarted.code).toBe(0);
      expect(restarted.out).toContain("server restarted, pid ");

      const status = await cli(root, "status");
      expect(status.code).toBe(0);
      expect(status.out).toContain(" up ");
      expect(status.out).toContain("gh: ok");
      expect(JSON.parse((await cli(root, "status", "--json")).out).pid).toBeGreaterThan(0);

      const pid = Number((await Bun.file(join(root, ".overbridge", "server.pid")).text()).trim());
      expect(await cli(root, "stop")).toEqual({ out: "server stopped\n", code: 0 });
      expect(() => process.kill(pid, 0)).toThrow();
      expect((await cli(root, "status")).code).toBe(1);
    } finally {
      await cli(root, "stop", "--force");
      rmSync(root, { recursive: true, force: true });
    }
  });
});
