import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSse, subscribeEvents } from "../src/events-client";
import { createHandler } from "../src/server";
import { changedFrame, createEvents, HEARTBEAT_FRAME } from "../src/server-events";
import { overbridgeVersion } from "../src/version";
import { shouldPoll } from "../src/zellij-view";

describe("createEvents", () => {
  test("publishes a changed frame to every subscriber, and stops after unsubscribe", () => {
    const hub = createEvents();
    const a: string[] = [];
    const b: string[] = [];
    const offA = hub.subscribe((f) => a.push(f));
    hub.subscribe((f) => b.push(f));
    hub.publish("top:w1");
    offA();
    hub.publish("perf");
    expect(a).toEqual([changedFrame("top:w1")]);
    expect(b).toEqual([changedFrame("top:w1"), changedFrame("perf")]);
    expect(hub.count).toBe(1);
  });

  test("a subscriber that throws is dropped and the others still get the frame", () => {
    const hub = createEvents();
    const got: string[] = [];
    hub.subscribe(() => {
      throw new Error("closed");
    });
    hub.subscribe((f) => got.push(f));
    hub.publish("k");
    expect(got).toEqual([changedFrame("k")]);
    expect(hub.count).toBe(1);
    hub.heartbeat();
    expect(got.at(-1)).toBe(HEARTBEAT_FRAME);
  });
});

describe("parseSse", () => {
  test("returns complete frames and keeps the unfinished rest", () => {
    const r = parseSse(`${changedFrame("a")}${changedFrame("b")}event: changed\ndata: {"key"`);
    expect(r.frames.map((f) => JSON.parse(f.data).key)).toEqual(["a", "b"]);
    expect(r.rest).toBe('event: changed\ndata: {"key"');
  });

  test("skips comment frames and handles CRLF", () => {
    const r = parseSse(`: ping\n\nevent: changed\r\ndata: {"key":"x"}\r\n\r\n`);
    expect(r.frames).toEqual([{ event: "changed", data: '{"key":"x"}' }]);
  });
});

describe("shouldPoll", () => {
  const hidden = { order: [], focused: "other" };
  test("a hidden pane with a live stream never polls; a focused one always does", () => {
    expect(shouldPoll("me", hidden as never, 0, 10 * 60_000, true)).toBe(false);
    expect(shouldPoll("me", hidden as never, 0, 10 * 60_000, false)).toBe(true);
    expect(shouldPoll("me", { order: [], focused: "me" } as never, 0, 0, true)).toBe(true);
  });
});

describe("GET /events", () => {
  let tmp: string;
  let sock: string;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let refreshes = 0;
  const handler = () =>
    createHandler({
      refreshTop: async () => (refreshes++, { at: Date.now() }) as never,
      refreshPerf: async () => Date.now(),
      workspaceExists: () => true,
      cacheFileAt: () => 0,
      version: overbridgeVersion(),
      onVersionMismatch: () => undefined,
    });
  let h: ReturnType<typeof handler>;
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "ob-ev-")));
    sock = join(tmp, "s.sock");
    refreshes = 0;
    h = handler();
    server = Bun.serve({ unix: sock, fetch: (req, srv) => (srv.timeout(req, 0), h.handle(req)) });
  });
  afterEach(async () => {
    h.closeStreams();
    await server?.stop(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  const until = async (cond: () => boolean, ms = 1500) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await Bun.sleep(10);
    return cond();
  };

  test("a pane hears a top refresh within a second, naming the key", async () => {
    const keys: string[] = [];
    const sub = subscribeEvents({ sock, onChange: (k) => keys.push(k) });
    expect(await until(() => sub.live())).toBe(true);
    expect(h.subscribers()).toBe(1);
    const t0 = Date.now();
    await h.handle(new Request("http://x/refresh/top/w1?force=1", { method: "POST" }));
    expect(await until(() => keys.includes("top:w1"))).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
    sub.stop();
  });

  test("a perf rebuild publishes perf, and a worklist rebuild publishes worklist once per build", async () => {
    let at = 1;
    const wl = createHandler({ refreshTop: async () => ({}) as never, refreshPerf: async () => Date.now(), refreshWorklist: async () => at, workspaceExists: () => true, cacheFileAt: () => 0, version: overbridgeVersion(), onVersionMismatch: () => undefined });
    const keys: string[] = [];
    wl.handle(new Request("http://x/events")).then(async (res) => {
      const reader = res.body!.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        keys.push(new TextDecoder().decode(value));
      }
    });
    await Bun.sleep(20);
    await wl.handle(new Request("http://x/refresh/perf?force=1", { method: "POST" }));
    await wl.handle(new Request("http://x/refresh/worklist", { method: "POST" }));
    await wl.handle(new Request("http://x/refresh/worklist", { method: "POST" }));
    at = 2;
    await wl.handle(new Request("http://x/refresh/worklist", { method: "POST" }));
    const text = keys.join("");
    expect(text).toContain(changedFrame("perf"));
    expect(text.split(changedFrame("worklist")).length - 1).toBe(2);
    wl.closeStreams();
  });

  test("a subscriber holds off idle exit, and a dropped one releases it", async () => {
    let t = 0;
    const idle = createHandler({ refreshTop: async () => ({}) as never, refreshPerf: async () => 0, workspaceExists: () => true, cacheFileAt: () => 0, version: overbridgeVersion(), onVersionMismatch: () => undefined, now: () => t });
    const res = await idle.handle(new Request("http://x/events"));
    t = 20 * 60_000;
    expect(idle.idleForMs()).toBe(0);
    await res.body!.cancel();
    expect(idle.subscribers()).toBe(0);
    expect(idle.idleForMs()).toBe(20 * 60_000);
  });

  test("closeStreams ends the stream so the pane sees the server go and reconnects when one returns", async () => {
    const states: boolean[] = [];
    const sub = subscribeEvents({ sock, reconnectMinMs: 20, onChange: () => undefined, onConnection: (v) => states.push(v) });
    expect(await until(() => sub.live())).toBe(true);
    h.closeStreams();
    expect(await until(() => !sub.live() || states.length >= 3)).toBe(true);
    // the server is still listening, so the pane is back on its own
    expect(await until(() => states.filter(Boolean).length >= 2)).toBe(true);
    sub.stop();
    expect(sub.live()).toBe(false);
  });

  test("no server: not live, and no throw", async () => {
    const sub = subscribeEvents({ sock: join(tmp, "none.sock"), reconnectMinMs: 10_000, onChange: () => undefined });
    await Bun.sleep(50);
    expect(sub.live()).toBe(false);
    sub.stop();
  });

  test("a hung server (no bytes) is dropped after staleMs", async () => {
    const quiet = join(tmp, "q.sock");
    const q = Bun.serve({ unix: quiet, fetch: (req, srv) => (srv.timeout(req, 0), new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": connected\n\n")); } }), { headers: { "content-type": "text/event-stream" } })) });
    const states: boolean[] = [];
    const sub = subscribeEvents({ sock: quiet, staleMs: 80, reconnectMinMs: 10_000, onChange: () => undefined, onConnection: (v) => states.push(v) });
    expect(await until(() => states.includes(true))).toBe(true);
    expect(await until(() => states.at(-1) === false)).toBe(true);
    sub.stop();
    await q.stop(true);
  });
});
