import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedExec, PR_FACT_TTL_MS } from "../src/cleanup-gather";
import { Verdict } from "../src/merge-sweep";
import { createHandler } from "../src/server";
import { createSweeper, type SweeperDeps } from "../src/server-sweep";
import { createSweepTrigger, SERVER_CHECK_MS } from "../src/sweep-trigger";
import type { RunResult } from "../src/util";

const deps = (o: Partial<SweeperDeps> = {}): SweeperDeps => ({
  claim: () => true,
  stale: () => [],
  refresh: async () => undefined,
  sweep: () => ({}),
  now: () => 1000,
  log: () => undefined,
  ...o,
});

describe("createSweeper", () => {
  test("does nothing while the interval is not due", async () => {
    let swept = 0;
    const s = createSweeper(deps({ claim: () => false, sweep: () => (swept++, {}) }));
    expect(await s.tick()).toBe(false);
    expect(swept).toBe(0);
    expect(s.stats().runs).toBe(0);
  });

  test("refreshes the stale workspaces, then sweeps once", async () => {
    const order: string[] = [];
    const s = createSweeper(
      deps({
        stale: () => ["a", "b"],
        refresh: async (ws) => void order.push(`refresh ${ws}`),
        sweep: () => (order.push("sweep"), { a: Verdict.Keep, b: Verdict.Remove }),
      }),
    );
    expect(await s.tick()).toBe(true);
    expect(order).toEqual(["refresh a", "refresh b", "sweep"]);
    expect(s.stats()).toMatchObject({ runs: 1, running: false, lastChecked: 2 });
  });

  test("a refresh that throws reaches the sweep as a failure, and the sweep still runs", async () => {
    let seen: ReadonlyMap<string, Error> = new Map();
    const s = createSweeper(
      deps({
        stale: () => ["a", "b"],
        refresh: async (ws) => {
          if (ws === "a") throw new Error("gh down");
        },
        sweep: (failed) => ((seen = failed), {}),
      }),
    );
    await s.tick();
    expect([...seen.keys()]).toEqual(["a"]);
    expect(seen.get("a")?.message).toBe("gh down");
  });

  test("a tick during a running sweep is skipped, never stacked", async () => {
    let release = () => {};
    let claims = 0;
    const s = createSweeper(
      deps({
        claim: () => (claims++, true),
        stale: () => ["a"],
        refresh: () => new Promise<void>((r) => (release = r)),
      }),
    );
    const first = s.tick();
    expect(s.busy).toBe(true);
    expect(await s.tick()).toBe(false);
    expect(claims).toBe(1);
    release();
    await first;
    expect(s.busy).toBe(false);
  });

  test("a claim that throws is recorded and does not reject", async () => {
    const s = createSweeper(deps({ claim: () => { throw new Error("state.json: bad"); } }));
    expect(await s.tick()).toBe(false);
    expect(s.stats().lastError).toBe("state.json: bad");
    expect(s.busy).toBe(false);
  });

  test("a sweep that throws is recorded and the next one runs", async () => {
    const logged: string[] = [];
    let boom = true;
    const s = createSweeper(deps({ log: (m) => logged.push(m), sweep: () => { if (boom) throw new Error("state unreadable"); return {}; } }));
    await s.tick();
    expect(s.stats().lastError).toBe("state unreadable");
    expect(logged[0]).toContain("state unreadable");
    boom = false;
    await s.tick();
    expect(s.stats().lastError).toBeUndefined();
    expect(s.stats().runs).toBe(2);
  });
});

describe("GET /sweep", () => {
  const handler = (extra: object) =>
    createHandler({ refreshTop: async () => ({}) as never, refreshPerf: async () => 0, workspaceExists: () => true, cacheFileAt: () => 0, version: "v", onVersionMismatch: () => undefined, ...extra });

  test("answers that the server owns the sweep, with its counters", async () => {
    const h = handler({ sweepStats: () => ({ runs: 3 }), sweepBusy: () => true });
    const res = await h.handle(new Request("http://x/sweep"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ owner: true, runs: 3 });
    expect(h.busy()).toBe(true);
  });

  test("404 when the server has no sweep, so a sidebar sweeps itself", async () => {
    expect((await handler({}).handle(new Request("http://x/sweep"))).status).toBe(404);
  });
});

describe("createSweepTrigger", () => {
  const make = (owns: () => Promise<boolean>) => {
    const t = { now: 0, claims: 0, starts: 0, asks: 0 };
    const trigger = createSweepTrigger({
      serverOwns: () => (t.asks++, owns()),
      claim: () => (t.claims++, true),
      start: () => void t.starts++,
      now: () => t.now,
    });
    return { t, trigger };
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  test("the first poll sweeps itself, since the server has not answered yet", () => {
    const { t, trigger } = make(async () => true);
    trigger();
    expect(t.starts).toBe(1);
  });

  test("once the server answers it owns the sweep, and the sidebar never claims or spawns", async () => {
    const { t, trigger } = make(async () => true);
    trigger();
    await settle();
    t.now = 1000;
    trigger();
    trigger();
    expect(t.claims).toBe(1);
    expect(t.starts).toBe(1);
  });

  test("with the server down the sidebar falls back to claim and spawn on every turn", async () => {
    const { t, trigger } = make(async () => false);
    trigger();
    await settle();
    t.now = 1000;
    trigger();
    expect(t.starts).toBe(2);
  });

  test("a failed ask counts as the server being down", async () => {
    const { t, trigger } = make(async () => {
      throw new Error("socket");
    });
    trigger();
    await settle();
    t.now = 1;
    trigger();
    expect(t.starts).toBe(2);
  });

  test("asks the server at most once per check interval", async () => {
    const { t, trigger } = make(async () => true);
    trigger();
    await settle();
    t.now = SERVER_CHECK_MS - 1;
    trigger();
    expect(t.asks).toBe(1);
    t.now = SERVER_CHECK_MS;
    trigger();
    expect(t.asks).toBe(2);
  });

  test("does not ask again while an answer is pending", () => {
    const { t, trigger } = make(() => new Promise<boolean>(() => undefined));
    trigger();
    t.now = SERVER_CHECK_MS * 5;
    trigger();
    expect(t.asks).toBe(1);
  });
});

describe("cachedExec", () => {
  let tmp: string;
  const saved = process.env.OVERBRIDGE_ROOT;
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-ce-")));
    process.env.OVERBRIDGE_ROOT = tmp;
  });
  afterEach(() => {
    saved === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = saved);
    rmSync(tmp, { recursive: true, force: true });
  });

  const ok = (stdout: string): RunResult => ({ ok: true, code: 0, stdout, stderr: "" });
  const fail: RunResult = { ok: false, code: 1, stdout: "", stderr: "boom" };
  const view = ["gh", "pr", "view", "12", "--json", "state"];

  test("a PR read is made once per TTL, per command and directory", () => {
    let calls = 0;
    let t = 0;
    const exec = cachedExec(() => (calls++, ok("{}")), () => t);
    exec(view, "/a");
    exec(view, "/a");
    expect(calls).toBe(1);
    exec(view, "/b");
    expect(calls).toBe(2);
    t = PR_FACT_TTL_MS;
    exec(view, "/a");
    expect(calls).toBe(3);
  });

  test("git and other gh calls always run", () => {
    let calls = 0;
    const exec = cachedExec(() => (calls++, ok("x")));
    exec(["git", "status"], "/a");
    exec(["git", "status"], "/a");
    exec(["gh", "pr", "merge", "1"], "/a");
    exec(["gh", "pr", "merge", "1"], "/a");
    expect(calls).toBe(4);
  });

  test("a failed read is returned as the failure, never cached, and never answered from an old success", () => {
    let t = 0;
    let next: RunResult = ok("old");
    const exec = cachedExec(() => next, () => t);
    expect(exec(view, "/a").stdout).toBe("old");
    t = PR_FACT_TTL_MS + 1;
    next = fail;
    expect(exec(view, "/a")).toEqual(fail);
    expect(exec(view, "/a")).toEqual(fail);
  });

  test("the PR commits lookup is cached too", () => {
    let calls = 0;
    const exec = cachedExec(() => (calls++, ok("[]")));
    exec(["gh", "api", "repos/{owner}/{repo}/commits/abc/pulls"], "/a");
    exec(["gh", "api", "repos/{owner}/{repo}/commits/abc/pulls"], "/a");
    expect(calls).toBe(1);
  });
});
