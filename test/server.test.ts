import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheStale } from "../src/agent-hook";
import { createHandler, type HandlerDeps } from "../src/server";
import { serverRefresh, serverRefreshAll } from "../src/server-client";
import { call, claimStart, notifyRefresh, socketPath, START_LOCK_MS, startServer, takePidFile, VERSION_HEADER } from "../src/server-net";
import { pidAlive } from "../src/proc";
import type { TopCache } from "../src/top";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const saved = { root: process.env.OVERBRIDGE_ROOT, self: process.env.OVERBRIDGE_SELF, name: process.env.OVERBRIDGE_NAME };
let tmp: string;
let meta: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "ob-srv-")));
  meta = join(tmp, ".overbridge");
  mkdirSync(meta, { recursive: true });
  process.env.OVERBRIDGE_ROOT = tmp;
  process.env.OVERBRIDGE_SELF = `${process.execPath} ${CLI}`;
  process.env.OVERBRIDGE_NAME = "";
  writeFileSync(join(meta, "state.json"), JSON.stringify({ version: 1, workspaces: { w1: { created: "", repos: {} }, w2: { created: "", repos: {} } } }));
});

afterEach(() => {
  stopServer();
  for (const [k, v] of [["OVERBRIDGE_ROOT", saved.root], ["OVERBRIDGE_SELF", saved.self], ["OVERBRIDGE_NAME", saved.name]] as const) {
    v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
  rmSync(tmp, { recursive: true, force: true });
});

const pidOf = (): number | undefined => {
  try {
    return Number(readFileSync(join(meta, "server.pid"), "utf8"));
  } catch {
    return undefined;
  }
};

function stopServer() {
  const pid = pidOf();
  if (pid) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

const spawnServer = () => Bun.spawn({ cmd: [process.execPath, CLI, "serve"], env: process.env, stdout: "ignore", stderr: "ignore" });

async function until(ok: () => boolean | Promise<boolean>, ms = 5_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await Bun.sleep(25);
  }
  throw new Error("timed out");
}

const cacheOf = (at = 1): TopCache => ({ links: [], prsOpen: false, at });

function handlerDeps(over: Partial<HandlerDeps> = {}) {
  const refreshed: string[] = [];
  let mismatches = 0;
  const deps: HandlerDeps = {
    refreshTop: async (ws) => {
      refreshed.push(ws);
      await Bun.sleep(5);
      return cacheOf();
    },
    workspaceExists: (ws) => ws === "w1" || ws === "w2",
    version: "v1",
    onVersionMismatch: () => {
      mismatches++;
    },
    ...over,
  };
  return { deps, refreshed, mismatches: () => mismatches };
}

const post = (h: ReturnType<typeof createHandler>, path: string, headers: Record<string, string> = {}) => h.handle(new Request(`http://x${path}`, { method: "POST", headers }));

describe("routes", () => {
  test("the panel, the hook and the sweep on one workspace inside a window cause one refresh", async () => {
    const { deps, refreshed } = handlerDeps();
    const h = createHandler(deps);
    const [panel, hook, sweep] = await Promise.all([post(h, "/refresh/top/w1"), post(h, "/refresh/top/w1?async=1"), post(h, "/refresh/top/w1")]);
    expect([panel.status, hook.status, sweep.status]).toEqual([200, 202, 200]);
    expect(await post(h, "/refresh/top/w1").then((r) => r.json())).toMatchObject({ served: "hit" });
    expect(refreshed).toEqual(["w1"]);
  });

  test("other workspaces refresh separately; force skips the ttl", async () => {
    const { deps, refreshed } = handlerDeps();
    let t = 0;
    const h = createHandler({ ...deps, now: () => t });
    await post(h, "/refresh/top/w1");
    await post(h, "/refresh/top/w2");
    t += 6_000;
    await post(h, "/refresh/top/w1?force=1");
    expect(refreshed).toEqual(["w1", "w2", "w1"]);
  });

  test("an unknown or malformed workspace is a 404", async () => {
    const h = createHandler(handlerDeps().deps);
    expect((await post(h, "/refresh/top/nope")).status).toBe(404);
    expect((await post(h, "/refresh/top/..%2Fx")).status).toBe(404);
    expect((await h.handle(new Request("http://x/other"))).status).toBe(404);
  });

  test("a failed refresh with nothing cached is a 502", async () => {
    const h = createHandler(
      handlerDeps({
        refreshTop: async () => {
          throw new Error("gh down");
        },
      }).deps,
    );
    const r = await post(h, "/refresh/top/w1");
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "gh down" });
  });

  test("status reports counters", async () => {
    const h = createHandler(handlerDeps().deps);
    await post(h, "/refresh/top/w1");
    await post(h, "/refresh/top/w1");
    const s = (await h.handle(new Request("http://x/status")).then((r) => r.json())) as Record<string, unknown>;
    expect(s).toMatchObject({ version: "v1", hits: 1, misses: 1, fetches: 1, inFlight: 0, draining: false });
  });

  test("a client of another version gets a 409 and the server is told to go", async () => {
    const { deps, mismatches } = handlerDeps();
    const h = createHandler(deps);
    expect((await post(h, "/refresh/top/w1", { [VERSION_HEADER]: "v1" })).status).toBe(200);
    expect((await post(h, "/refresh/top/w1", { [VERSION_HEADER]: "v2" })).status).toBe(409);
    expect(mismatches()).toBe(1);
  });
});

describe("socket path", () => {
  test("sits in the meta dir, or under the runtime dir when the root is too deep", () => {
    expect(socketPath("/r")).toBe("/r/.overbridge/server.sock");
    const deep = socketPath(`/${"d".repeat(120)}`);
    expect(deep.length).toBeLessThan(104);
    expect(deep).toMatch(/overbridge-[0-9a-f]{12}\.sock$/);
  });
});

describe("pid file", () => {
  test("a live holder keeps it; a dead one's is replaced", () => {
    const file = join(tmp, "p.pid");
    expect(takePidFile(file, () => true, 100)).toBe(true);
    expect(takePidFile(file, () => true, 200)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("100");
    expect(takePidFile(file, () => false, 200)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("200");
  });
});

describe("start throttle", () => {
  test("a start is attempted once per window", () => {
    const spawned: string[][] = [];
    expect(startServer((c) => spawned.push(c), 1_000_000)).toBe(true);
    expect(startServer((c) => spawned.push(c), 1_000_000 + START_LOCK_MS - 1)).toBe(false);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.at(-1)).toBe("serve");
    expect(claimStart(Date.now() + START_LOCK_MS * 2)).toBe(true);
  });
});

describe("server stopped: callers fall back", () => {
  test("nothing listening resolves undefined or false, fast, without starting one", async () => {
    const began = Date.now();
    expect(await call("GET", "/status", { timeoutMs: 500 })).toBeUndefined();
    expect(await serverRefresh("w1", { start: false })).toBeUndefined();
    expect(await notifyRefresh("w1", { start: false })).toBe(false);
    await serverRefreshAll(["w1", "w2"]).catch(() => undefined);
    expect(Date.now() - began).toBeLessThan(2_000);
  });

  test("a stale socket file answers like no server", async () => {
    writeFileSync(socketPath(), "");
    expect(await serverRefresh("w1", { start: false })).toBeUndefined();
  });

  test("the hook only asks for a refresh once the cache file is a minute old", () => {
    mkdirSync(join(meta, "top"), { recursive: true });
    const file = join(meta, "top", "w1.json");
    expect(cacheStale(meta, "w1")).toBe(true);
    writeFileSync(file, "{}");
    expect(cacheStale(meta, "w1")).toBe(false);
    const old = Date.now() / 1000 - 120;
    utimesSync(file, old, old);
    expect(cacheStale(meta, "w1")).toBe(true);
  });
});

describe("real server", () => {
  test("serves a refresh on its socket, writes the cache file, and a second start exits", async () => {
    const first = spawnServer();
    await until(() => existsSync(socketPath()));
    const r = await serverRefresh("w1", { start: false });
    expect(r).toMatchObject({ ws: "w1", served: "fresh" });
    expect(existsSync(join(meta, "top", "w1.json"))).toBe(true);
    expect(await serverRefresh("w1", { start: false })).toMatchObject({ served: "hit" });
    const status = JSON.parse((await call("GET", "/status", { timeoutMs: 2_000 }))!.body);
    expect(status).toMatchObject({ fetches: 1, hits: 1, misses: 1, pid: first.pid });
    expect((await Bun.file(socketPath()).stat()).mode & 0o777).toBe(0o600);

    const second = spawnServer();
    expect(await second.exited).toBe(0);
    expect(pidOf()).toBe(first.pid);
    expect(pidAlive(first.pid)).toBe(true);
    expect(await serverRefresh("w2", { start: false })).toMatchObject({ ws: "w2" });
  });

  test("a stale socket and pid file from a crash are replaced", async () => {
    writeFileSync(socketPath(), "");
    writeFileSync(join(meta, "server.pid"), "999999999");
    spawnServer();
    await until(async () => (await serverRefresh("w1", { start: false })) !== undefined);
    expect(pidOf()).not.toBe(999999999);
  });

  test("a client of another version makes the server exit, and the next call finds none", async () => {
    const s = spawnServer();
    await until(() => existsSync(socketPath()));
    const r = await call("POST", "/refresh/top/w1", { timeoutMs: 5_000, version: "other" });
    expect(r?.status).toBe(409);
    expect(await s.exited).toBe(0);
    expect(existsSync(socketPath())).toBe(false);
    expect(await serverRefresh("w1", { start: false })).toBeUndefined();
  });
});
