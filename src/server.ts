import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { NAME_RE, metaDir, selfCommand } from "./paths";
import { pidAlive } from "./proc";
import { Cache, errorText } from "./server-cache";
import { CONNECTED_FRAME, createEvents, HEARTBEAT_FRAME, HEARTBEAT_MS } from "./server-events";
import { CLIENT_START_HEADER, pidFile, stoppingFile, socketPath, takePidFile, VERSION_HEADER } from "./server-net";
import { defaultSweepDeps, staleCandidates, sweepMerged } from "./merge-sweep";
import { ghResetLookup, RateGate } from "./rate-limit";
import { startWatchdog } from "./server-watchdog";
import { createSweeper } from "./server-sweep";
import { readState } from "./state";
import { claimSweep } from "./sweep-trigger";
import { type PrefetchedPrs, readTopCache, type TopCache } from "./top";
import { PrBatcher } from "./pr-batch";
import { createWorklistRefresher } from "./server-worklist";
import { finishWorklist } from "./worklist-data";
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
/** How often the server checks whether the sweep is due. */
export const SWEEP_TICK_MS = 5_000;
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
  /** The rate-limit gate's state for `/status`. */
  rateStats?: () => unknown;
  /** The sweep timer's counters; present when the server runs the merged-PR sweep. `GET /sweep` answers 404 without it. */
  sweepStats?: () => unknown;
  sweepBusy?: () => boolean;
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
  const events = createEvents();
  /** Ends each open event stream; a stream the client drops removes itself. */
  const streams = new Set<() => void>();
  let lastWorklistAt = 0;
  const startedAt = now();
  let lastRequestAt = now();
  let draining = false;

  /** One workspace's top refresh through the shared cache: single flight, TTL, backoff, the in-flight cap. */
  function refreshWs(ws: string, force: boolean) {
    return cache.get(`top:${ws}`, async () => {
      const built = await deps.refreshTop(ws, { force });
      // the cache file is written by now, so a pane that reads it on this event sees the new value
      events.publish(`top:${ws}`);
      return built;
    }, {
      ttlMs: TOP_TTL_MS,
      staleMs: TOP_STALE_MS,
      force,
      // a cache file older than the TTL (rewritten, deleted or never written) is refreshed even when the entry is young
      expired: now() - deps.cacheFileAt(ws) >= TOP_TTL_MS,
    });
  }

  /** `GET /events`: a stream that stays open, with a heartbeat so both ends can tell the other is gone. */
  function eventStream(): Response {
    const enc = new TextEncoder();
    let cleanup = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (frame: string) => controller.enqueue(enc.encode(frame));
        const unsubscribe = events.subscribe(send);
        // each stream pings only itself; a failed write means the client is gone
        const beat = setInterval(() => {
          try {
            send(HEARTBEAT_FRAME);
          } catch {
            end();
          }
        }, HEARTBEAT_MS);
        const close = () => {
          end();
          try {
            controller.close();
          } catch {
            // already closed by the client
          }
        };
        function end() {
          clearInterval(beat);
          unsubscribe();
          streams.delete(close);
          // idle exit counts from the last stream closing, not from when it opened hours ago
          lastRequestAt = now();
        }
        cleanup = end;
        streams.add(close);
        send(CONNECTED_FRAME);
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
  }

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
      return json(200, { version: deps.version, pid: process.pid, uptimeMs: now() - startedAt, draining, subscribers: events.count, ...cache.stats(), perf: perf.stats(), ...(deps.prBatch ? { prBatch: deps.prBatch() } : {}), ...(deps.worklistStats ? { worklist: deps.worklistStats() } : {}), ...(deps.sweepStats ? { sweep: deps.sweepStats() } : {}), ...(deps.rateStats ? { rateLimit: deps.rateStats() } : {}) });
    }
    if (req.method === "GET" && url.pathname === "/events") {
      return eventStream();
    }
    if (req.method === "GET" && url.pathname === "/sweep" && deps.sweepStats) {
      // a sidebar asks this to learn the server runs the sweep, so it skips its own
      return json(200, { owner: true, ...(deps.sweepStats() as object) });
    }
    if (req.method === "POST" && url.pathname === "/refresh/perf") {
      const got = perf.get("perf", async () => {
        const at = await deps.refreshPerf();
        events.publish("perf");
        return at;
      }, { ttlMs: PERF_TTL_MS, staleMs: PERF_STALE_MS, force: url.searchParams.get("force") === "1", swr: true });
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
        const at = await deps.refreshWorklist(url.searchParams.get("force") === "1");
        // the worklist refresher serves its own cache, so only a new build is a change
        if (at !== lastWorklistAt) {
          lastWorklistAt = at;
          events.publish("worklist");
        }
        return json(200, { served: at });
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
      const got = refreshWs(ws, force);
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
    /** Refresh `ws` as the sweep does: through the cache, so a pane's refresh and the sweep's share one fetch. */
    refresh: (ws: string) => refreshWs(ws, false),
    stats: () => cache.stats(),
    /** Zero while a pane holds an event stream: the server stays up as long as someone is watching. */
    idleForMs: () => (events.count > 0 ? 0 : now() - lastRequestAt),
    subscribers: () => events.count,
    streamCount: () => streams.size,
    /** Publish a change from outside the routes (the sweep, tests). */
    publish: (key: string) => events.publish(key),
    /** End every event stream, so a client reconnects to whichever server runs next. */
    closeStreams: () => [...streams].forEach((close) => close()),
    busy: () => cache.busy || perf.busy || (deps.prBusy?.() ?? false) || (deps.worklistBusy?.() ?? false) || (deps.sweepBusy?.() ?? false),
  };
}

interface WorkerReply {
  ok: boolean;
  value?: unknown;
  cache?: TopCache;
  at?: number;
  error?: string;
}

/**
 * One job in a worker thread of `file`: resolves with `pick` of its reply, or rejects with the error text it sent, with
 * `fallback` when it sent none, or on timeout (`label` names the job). The worker is gone by the time this settles.
 */
function workerJob<T>(file: string, message: unknown, o: { timeoutMs: number; label: string; fallback: string; pick: (r: WorkerReply) => T | undefined }): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(file, import.meta.url).href);
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`${o.label} timed out`));
    }, o.timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      finish();
      const picked = e.data.ok ? o.pick(e.data) : undefined;
      if (picked !== undefined) resolve(picked);
      else reject(new Error(e.data.error ?? o.fallback));
    };
    worker.onerror = (e) => {
      finish();
      reject(new Error(e.message));
    };
    worker.postMessage(message);
  });
}

/** Run `refreshTop` in a worker thread, so the server stays responsive while `gh` runs. */
export const refreshInWorker = (ws: string, prefetched: PrefetchedPrs = {}, timeoutMs = 120_000, paused?: string): Promise<TopCache> =>
  workerJob("./server-worker.ts", { ws, prefetched, ...(paused ? { paused } : {}) }, { timeoutMs, label: `refresh of ${ws}`, fallback: "refresh failed", pick: (r) => r.cache });

/** Build the perf views in a worker thread: it reads and folds every workspace's history, which must not stall the server. Resolves with when they were built. */
export const refreshPerfInWorker = (timeoutMs = 30_000): Promise<number> =>
  workerJob("./server-perf-worker.ts", {}, { timeoutMs, label: "perf refresh", fallback: "perf refresh failed", pick: (r) => r.at });

/** One job in a worker thread of `file`: its `{ok, value}` reply, or a rejection with the error text or on timeout. */
export const workerCall = <T>(file: string, message: unknown, timeoutMs = 120_000): Promise<T> =>
  workerJob(file, message, { timeoutMs, label: file, fallback: "job failed", pick: (r) => r.value as T | undefined });

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
  // a stop that is over (this is a new server) must not stop the watchdog from restarting this one
  rmSync(stoppingFile(), { force: true });
  let exiting = false;
  // a rate-limit reply pauses every gh key until GitHub's reset: they serve what they hold and say why
  const gate = new RateGate({ lookupReset: ghResetLookup, log });
  const batcher = new PrBatcher({
    claimed: cachedClaimedPrs(CLAIMED_TTL_MS),
    paused: () => gate.message(),
    onError: (key, e) => {
      gate.observe(e.message);
      log(`${key}: ${e.message}`);
    },
  });
  const worklist = createWorklistRefresher({
    plan: () => workerCall("./server-worklist-worker.ts", { kind: "plan" }),
    read: async (source) => {
      const paused = source.kind === "github" ? gate.message() : undefined;
      // (a forced worklist refresh reads through the cache's own force and is not special-cased: boards fail soft)
      if (paused) throw new Error(paused);
      try {
        return await workerCall("./server-worklist-worker.ts", { kind: "read", source }, 60_000);
      } catch (e) {
        if (source.kind === "github") gate.observe(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    finish: (notes, read) => finishWorklist(notes, read),
  });
  let refreshForSweep: (ws: string) => Promise<unknown> = () => Promise.resolve();
  const sweeper = createSweeper({
    claim: claimSweep,
    stale: staleCandidates,
    refresh: (ws) => refreshForSweep(ws),
    sweep: (failed) =>
      sweepMerged({
        ...defaultSweepDeps(),
        // a workspace whose refresh failed keeps; the sweep never judges it from an old cache
        refresh: (ws) => {
          const e = failed.get(ws);
          if (e) throw e;
        },
      }),
    now: Date.now,
    log,
  });
  const handler = createHandler({
    sweepStats: () => sweeper.stats(),
    sweepBusy: () => sweeper.busy,
    refreshWorklist: async (force) => {
      const r = await worklist.refresh(force);
      // a failed planning job serves the last timestamp with `error`; the file was not rebuilt, so the route must not answer 200
      if (r.error) throw new Error(r.error);
      return r.value;
    },
    worklistStats: () => worklist.stats(),
    worklistBusy: () => worklist.busy,
    rateStats: () => gate.stats(),
    refreshTop: async (ws, o) => {
      // a forced refresh (the user's `r`) goes past the pause
      return refreshInWorker(ws, await prefetchFor(ws, batcher, o), 120_000, o?.force ? undefined : gate.message());
    },
    prBatch: () => batcher.stats(),
    prBusy: () => batcher.busy,
    refreshPerf: refreshPerfInWorker,
    workspaceExists: (ws) => ws in readState().workspaces,
    cacheFileAt: (ws) => readTopCache(ws).at,
    log,
    version: overbridgeVersion(),
    onVersionMismatch: () => void shutdown(),
  });
  refreshForSweep = async (ws) => {
    const got = await handler.refresh(ws);
    // a stale value served over a failed refresh is a failure here: the sweep must not judge that workspace from it
    if (got.error) throw new Error(got.error);
  };
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
  // a hung server answers nothing and cannot notice: a watchdog thread kills it and starts a replacement
  const stopWatchdog = startWatchdog({ stopMarker: stoppingFile(), restart: ["sh", "-c", 'sleep 1; exec "$@"', "sh", ...selfCommand(), "serve"] });

  async function shutdown() {
    if (exiting) return;
    exiting = true;
    // finish what runs, then go: the next client call starts the new version
    while (handler.busy()) await Bun.sleep(100);
    stopWatchdog();
    handler.closeStreams();
    await server.stop();
    rmSync(sock, { force: true });
    rmSync(pid, { force: true });
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  // sidebars ask `GET /sweep` and skip their own, so this is the one sweep; `claimSweep` keeps it to one per MERGE_SWEEP_MS
  setInterval(() => {
    if (!exiting) void sweeper.tick();
  }, SWEEP_TICK_MS);
  setInterval(() => {
    if (handler.idleForMs() >= IDLE_EXIT_MS && !handler.busy()) void shutdown();
  }, 30_000);
  await new Promise<void>(() => undefined);
}
