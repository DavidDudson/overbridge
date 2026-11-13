import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { NAME_RE, metaDir } from "./paths";
import { pidAlive } from "./proc";
import { Cache, errorText } from "./server-cache";
import { CLIENT_START_HEADER, pidFile, socketPath, takePidFile, VERSION_HEADER } from "./server-net";
import { readState } from "./state";
import { type PrefetchedPrs, readTopCache, type TopCache } from "./top";
import { PrBatcher } from "./pr-batch";
import { createWorklistRefresher } from "./server-worklist";
import { finishWorklist } from "./worklist-run";
import { cachedClaimedPrs, prefetchFor } from "./server-prs";
import { log } from "./util";
import { overbridgeVersion } from "./version";

/**
 * `overbridge serve`: one process per workspaces root that owns the network refreshes and serves one cache over HTTP on
 * a unix socket. Panes still read the cache files; the server is a faster, coordinated writer of them. It keeps no
 * durable state, so a crash, kill or upgrade loses nothing that one refresh does not rebuild.
 */

/** How old the claimed-PR list the batcher adds to each query may be: state and stack catalogs are read once per this. */
export const CLAIMED_TTL_MS = 5_000;

export const TOP_TTL_MS = 60_000;
export const TOP_STALE_MS = 10 * 60_000;
/** The perf views are cheap to build, so they are rebuilt often; a stale set is served while one builds. */
export const PERF_TTL_MS = 5_000;
export const PERF_STALE_MS = 60_000;
export const IDLE_EXIT_MS = 10 * 60_000;
/** Refreshes running at once: each runs `gh` calls of its own. */
export const MAX_REFRESHES = 4;

export interface HandlerDeps {
  refreshTop: (ws: string, o?: { force?: boolean }) => Promise<TopCache>;
  /** Build every perf view and write `perf.json`; resolves with when it was built (a cached value cannot be undefined). */
  refreshPerf: () => Promise<number>;
  /** Refresh the work list (`worklist.json`); resolves with when. Absent: the route answers 404 and the pane runs a child. */
  refreshWorklist?: (force: boolean) => Promise<number>;
  worklistStats?: () => unknown;
  workspaceExists: (ws: string) => boolean;
  /** When `ws`'s top cache file was last written (ms since epoch), 0 when it has none. */
  cacheFileAt: (ws: string) => number;
  version: string;
  /** What the PR batcher has done, for `/status`. */
  prBatch?: () => unknown;
  prBusy?: () => boolean;
  worklistBusy?: () => boolean;
  /** Called when a client of another version, started after this server, calls: finish what is running, then exit. */
  onVersionMismatch: () => void;
  /** Where a failed refresh is reported; the server's own stdio is ignored. */
  log?: (msg: string) => void;
  now?: () => number;
}

const json = (status: number, body: unknown) => Response.json(body, { status });

/** The routes, apart from the socket, so tests call them directly. */
export function createHandler(deps: HandlerDeps) {
  const now = deps.now ?? Date.now;
  const report = deps.log ?? (() => undefined);
  const cache = new Cache<TopCache>({ maxInFlight: MAX_REFRESHES, now, onError: (key, e) => report(`${key}: ${e.message}`) });
  const perf = new Cache<number>({ maxInFlight: 1, now, onError: (key, e) => report(`${key}: ${e.message}`) });
  const startedAt = now();
  let lastRequestAt = now();
  let draining = false;

  async function handle(req: Request): Promise<Response> {
    lastRequestAt = now();
    const url = new URL(req.url);
    const theirs = req.headers.get(VERSION_HEADER);
    if (theirs && theirs !== deps.version) {
      // only a client started after this server may replace it: an older pane that outlived an upgrade must not
      // keep killing the new server
      if (Number(req.headers.get(CLIENT_START_HEADER)) > startedAt) {
        draining = true;
        deps.onVersionMismatch();
      }
      return json(409, { error: "version mismatch", server: deps.version, client: theirs });
    }
    if (req.method === "GET" && url.pathname === "/status") {
      return json(200, { version: deps.version, pid: process.pid, uptimeMs: now() - startedAt, draining, ...cache.stats(), perf: perf.stats(), ...(deps.prBatch ? { prBatch: deps.prBatch() } : {}), ...(deps.worklistStats ? { worklist: deps.worklistStats() } : {}) });
    }
    if (req.method === "POST" && url.pathname === "/refresh/perf") {
      const got = perf.get("perf", () => deps.refreshPerf(), { ttlMs: PERF_TTL_MS, staleMs: PERF_STALE_MS, force: url.searchParams.get("force") === "1", swr: true });
      if (url.searchParams.get("async") === "1") {
        got.catch(() => undefined);
        return json(202, { queued: "perf" });
      }
      try {
        const { served, error } = await got;
        return json(200, { served, ...(error ? { error } : {}) });
      } catch (e) {
        return json(502, { error: errorText(e) });
      }
    }
    if (req.method === "POST" && url.pathname === "/refresh/worklist" && deps.refreshWorklist) {
      try {
        return json(200, { served: await deps.refreshWorklist(url.searchParams.get("force") === "1") });
      } catch (e) {
        return json(502, { error: errorText(e) });
      }
    }
    const top = /^\/refresh\/top\/([^/]+)$/.exec(url.pathname);
    if (req.method === "POST" && top) {
      let ws: string;
      try {
        ws = decodeURIComponent(top[1]!);
      } catch {
        return json(400, { error: "bad workspace name" });
      }
      if (!NAME_RE.test(ws) || !deps.workspaceExists(ws)) return json(404, { error: `no workspace ${ws}` });
      const force = url.searchParams.get("force") === "1";
      const got = cache.get(`top:${ws}`, () => deps.refreshTop(ws, { force }), {
        ttlMs: TOP_TTL_MS,
        staleMs: TOP_STALE_MS,
        force,
        // a cache file older than the TTL (rewritten, deleted or never written) is refreshed even when the entry is young
        expired: now() - deps.cacheFileAt(ws) >= TOP_TTL_MS,
      });
      if (url.searchParams.get("async") === "1") {
        got.catch(() => undefined);
        return json(202, { queued: ws });
      }
      try {
        const { served, error } = await got;
        return json(200, { ws, served, ...(error ? { error } : {}) });
      } catch (e) {
        return json(502, { error: errorText(e) });
      }
    }
    return json(404, { error: "not found" });
  }

  return {
    handle,
    stats: () => cache.stats(),
    idleForMs: () => now() - lastRequestAt,
    busy: () => cache.busy || perf.busy || (deps.prBusy?.() ?? false) || (deps.worklistBusy?.() ?? false),
  };
}

/** Run `refreshTop` in a worker thread, so the server stays responsive while `gh` runs. */
export function refreshInWorker(ws: string, prefetched: PrefetchedPrs = {}, timeoutMs = 120_000): Promise<TopCache> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./server-worker.ts", import.meta.url).href);
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`refresh of ${ws} timed out`));
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    worker.onmessage = (e: MessageEvent<{ ok: boolean; cache?: TopCache; error?: string }>) => {
      finish();
      if (e.data.ok && e.data.cache) resolve(e.data.cache);
      else reject(new Error(e.data.error ?? "refresh failed"));
    };
    worker.onerror = (e) => {
      finish();
      reject(new Error(e.message));
    };
    worker.postMessage({ ws, prefetched });
  });
}

/** Build the perf views in a worker thread: it reads and folds every workspace's history, which must not stall the server. Resolves with when they were built. */
export function refreshPerfInWorker(timeoutMs = 30_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./server-perf-worker.ts", import.meta.url).href);
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("perf refresh timed out"));
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    worker.onmessage = (e: MessageEvent<{ ok: boolean; at?: number; error?: string }>) => {
      finish();
      if (e.data.ok && e.data.at !== undefined) resolve(e.data.at);
      else reject(new Error(e.data.error ?? "perf refresh failed"));
    };
    worker.onerror = (e) => {
      finish();
      reject(new Error(e.message));
    };
    worker.postMessage({});
  });
}

/** One job in a worker thread of `file`: its `{ok, value}` reply, or a rejection with the error text or on timeout. */
export function workerCall<T>(file: string, message: unknown, timeoutMs = 120_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(file, import.meta.url).href);
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`${file} timed out`));
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    worker.onmessage = (e: MessageEvent<{ ok: boolean; value?: T; error?: string }>) => {
      finish();
      if (e.data.ok) resolve(e.data.value as T);
      else reject(new Error(e.data.error ?? "job failed"));
    };
    worker.onerror = (e) => {
      finish();
      reject(new Error(e.message));
    };
    worker.postMessage(message);
  });
}

/** `overbridge serve`: runs until idle, killed or a client of another version calls. */
export async function serve(): Promise<void> {
  mkdirSync(metaDir(), { recursive: true });
  const pid = pidFile();
  if (!takePidFile(pid, pidAlive)) {
    log("server already running");
    return;
  }
  const sock = socketPath();
  rmSync(sock, { force: true });
  let exiting = false;
  const batcher = new PrBatcher({ claimed: cachedClaimedPrs(CLAIMED_TTL_MS), onError: (key, e) => log(`${key}: ${e.message}`) });
  const worklist = createWorklistRefresher({
    plan: () => workerCall("./server-worklist-worker.ts", { kind: "plan" }),
    read: (source) => workerCall("./server-worklist-worker.ts", { kind: "read", source }, 60_000),
    finish: (notes, read) => finishWorklist(notes, read),
  });
  const handler = createHandler({
    refreshWorklist: async (force) => (await worklist.refresh(force)).value,
    worklistStats: () => worklist.stats(),
    worklistBusy: () => worklist.busy,
    refreshTop: async (ws, o) => refreshInWorker(ws, await prefetchFor(ws, batcher, o)),
    prBatch: () => batcher.stats(),
    prBusy: () => batcher.busy,
    refreshPerf: refreshPerfInWorker,
    workspaceExists: (ws) => ws in readState().workspaces,
    cacheFileAt: (ws) => readTopCache(ws).at,
    log,
    version: overbridgeVersion(),
    onVersionMismatch: () => void shutdown(),
  });
  const old = process.umask(0o177);
  // a refresh outlasts Bun's 10 s default idle timeout, so each request opts out of it
  const server = Bun.serve({
    unix: sock,
    fetch: (req, srv) => {
      srv.timeout(req, 0);
      return handler.handle(req);
    },
  });
  process.umask(old);
  try {
    chmodSync(sock, 0o600);
  } catch {
    // the socket is already 0600 from the umask set before Bun.serve
  }
  log(`serving on ${sock}`);

  async function shutdown() {
    if (exiting) return;
    exiting = true;
    // finish what runs, then go: the next client call starts the new version
    while (handler.busy()) await Bun.sleep(100);
    await server.stop();
    rmSync(sock, { force: true });
    rmSync(pid, { force: true });
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  setInterval(() => {
    if (handler.idleForMs() >= IDLE_EXIT_MS && !handler.busy()) void shutdown();
  }, 30_000);
  await new Promise<void>(() => undefined);
}
