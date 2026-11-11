import { describe, expect, test } from "bun:test";
import { Cache } from "../src/server-cache";

const opts = { ttlMs: 1_000, staleMs: 10_000 };

function setup(o: ConstructorParameters<typeof Cache>[0] = {}) {
  let t = 0;
  const cache = new Cache<number>({ now: () => t, ...o });
  return { cache, tick: (ms: number) => (t += ms) };
}

/** A fetcher the test settles by hand, counting its calls. */
function gate() {
  const waiting: Array<{ ok: (v: number) => void; fail: (e: Error) => void }> = [];
  return {
    fetch: () => new Promise<number>((ok, fail) => waiting.push({ ok, fail })),
    get calls() {
      return waiting.length;
    },
    settle: (i: number, v: number) => waiting[i]!.ok(v),
    reject: (i: number, msg: string) => waiting[i]!.fail(new Error(msg)),
  };
}

describe("single flight", () => {
  test("callers of one key share one fetch", async () => {
    const { cache } = setup();
    const g = gate();
    const all = [cache.get("k", g.fetch, opts), cache.get("k", g.fetch, opts), cache.get("k", g.fetch, opts)];
    expect(g.calls).toBe(1);
    g.settle(0, 7);
    const got = await Promise.all(all);
    expect(got.map((r) => r.value)).toEqual([7, 7, 7]);
    expect(got.map((r) => r.served)).toEqual(["fresh", "shared", "shared"]);
    expect(cache.stats().fetches).toBe(1);
  });
});

describe("ttl", () => {
  test("a value inside its ttl is a hit; past it, a fetch", async () => {
    const { cache, tick } = setup();
    let n = 0;
    const fetch = async () => ++n;
    expect((await cache.get("k", fetch, opts)).value).toBe(1);
    tick(999);
    expect(await cache.get("k", fetch, opts)).toMatchObject({ value: 1, served: "hit" });
    tick(2);
    expect(await cache.get("k", fetch, opts)).toMatchObject({ value: 2, served: "fresh" });
  });

  test("age counts from the start of the fetch, so a refresh every ttl is never skipped", async () => {
    const { cache, tick } = setup();
    let n = 0;
    const fetch = async () => {
      tick(400);
      return ++n;
    };
    await cache.get("k", fetch, opts);
    tick(600);
    expect((await cache.get("k", fetch, opts)).served).toBe("fresh");
  });

  test("swr serves the stale value at once and refetches behind it", async () => {
    const { cache, tick } = setup();
    const g = gate();
    const first = cache.get("k", g.fetch, opts);
    g.settle(0, 1);
    await first;
    tick(5_000);
    const stale = await cache.get("k", g.fetch, { ...opts, swr: true });
    expect(stale).toMatchObject({ value: 1, served: "stale" });
    expect(g.calls).toBe(2);
    g.settle(1, 2);
    await Bun.sleep(0);
    expect(await cache.get("k", g.fetch, opts)).toMatchObject({ value: 2, served: "hit" });
  });

  test("a value past the stale limit is waited for even with swr", async () => {
    const { cache, tick } = setup();
    await cache.get("k", async () => 1, opts);
    tick(20_000);
    expect(await cache.get("k", async () => 2, { ...opts, swr: true })).toMatchObject({ value: 2, served: "fresh" });
  });
});

describe("errors", () => {
  test("a failure keeps the last good value and backs off, doubling to a cap", async () => {
    const { cache, tick } = setup({ backoffBaseMs: 100, backoffMaxMs: 250 });
    await cache.get("k", async () => 1, opts);
    tick(2_000);
    let calls = 0;
    const bad = async (): Promise<number> => {
      calls++;
      throw new Error("offline");
    };
    expect(await cache.get("k", bad, opts)).toMatchObject({ value: 1, served: "stale", error: "offline" });
    tick(50);
    expect(await cache.get("k", bad, opts)).toMatchObject({ value: 1, served: "stale" });
    expect(calls).toBe(1);
    tick(60);
    await cache.get("k", bad, opts);
    expect(calls).toBe(2);
    tick(150);
    await cache.get("k", bad, opts);
    expect(calls).toBe(2);
    tick(60);
    await cache.get("k", bad, opts);
    expect(calls).toBe(3);
    expect(cache.stats().keys.k!.failures).toBe(3);
  });

  test("a key that never succeeded throws its error", async () => {
    const { cache } = setup();
    await expect(
      cache.get("k", async () => {
        throw new Error("nope");
      }, opts),
    ).rejects.toThrow("nope");
    await expect(cache.get("k", async () => 1, opts)).rejects.toThrow("nope");
  });

  test("a success clears the backoff", async () => {
    const { cache, tick } = setup({ backoffBaseMs: 100 });
    await cache.get("k", async () => 1, opts).catch(() => undefined);
    tick(2_000);
    await cache
      .get("k", async () => {
        throw new Error("x");
      }, opts)
      .catch(() => undefined);
    tick(200);
    expect((await cache.get("k", async () => 3, opts)).value).toBe(3);
    expect(cache.stats().keys.k).toEqual({ at: 2_200, failures: 0 });
  });
});

describe("force", () => {
  test("skips the ttl but not more often than the gap", async () => {
    const { cache, tick } = setup();
    let n = 0;
    const fetch = async () => ++n;
    await cache.get("k", fetch, opts);
    tick(10);
    expect((await cache.get("k", fetch, { ...opts, force: true, minForceGapMs: 5_000 })).served).toBe("hit");
    tick(5_000);
    expect(await cache.get("k", fetch, { ...opts, force: true, minForceGapMs: 5_000 })).toMatchObject({ value: 2, served: "fresh" });
  });
});

describe("limits", () => {
  test("no more fetches run at once than the limit, and a finished one frees its slot", async () => {
    const { cache } = setup({ maxInFlight: 2 });
    const g = gate();
    const all = ["a", "b", "c", "d"].map((k) => cache.get(k, g.fetch, opts));
    await Bun.sleep(0);
    expect(g.calls).toBe(2);
    expect(cache.stats()).toMatchObject({ inFlight: 2, queued: 2 });
    g.settle(0, 1);
    await Bun.sleep(0);
    expect(g.calls).toBe(3);
    g.settle(1, 1);
    g.settle(2, 1);
    await Bun.sleep(0);
    g.settle(3, 1);
    await Promise.all(all);
    expect(cache.stats()).toMatchObject({ inFlight: 0, queued: 0 });
    expect(cache.busy).toBe(false);
  });

  test("the oldest idle entry goes once the cap is passed", async () => {
    const { cache } = setup({ maxEntries: 2 });
    for (const k of ["a", "b", "c"]) await cache.get(k, async () => 1, opts);
    expect(Object.keys(cache.stats().keys)).toEqual(["b", "c"]);
  });

  test("invalidate drops a key or a prefix", async () => {
    const { cache } = setup();
    for (const k of ["top:a", "top:b", "gh:x"]) await cache.get(k, async () => 1, opts);
    cache.invalidate("top:a");
    cache.invalidate("top:", true);
    expect(Object.keys(cache.stats().keys)).toEqual(["gh:x"]);
  });
});
