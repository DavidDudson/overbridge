import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NAME_RE, metaDir, selfCommand } from "./paths";
import { pidAlive } from "./proc";
import { Cache, type CacheStats, errorText, type Served } from "./server-cache";
import { CONNECTED_FRAME, createEvents, HEARTBEAT_FRAME, HEARTBEAT_MS } from "./server-events";
import { BUILD_HEADER, pidFile, stoppingFile, socketPath, takePidFile, VERSION_HEADER } from "./server-net";
import { defaultSweepDeps, staleCandidates, sweepMerged } from "./merge-sweep";
import { ghResetLookup, RateGate } from "./rate-limit";
import { startWatchdog } from "./server-watchdog";
import { createSweeper } from "./server-sweep";
import { readState } from "./state";
import { claimSweep } from "./sweep-trigger";
import { type PrefetchedPrs, type PrView, readTopCache, type TopCache } from "./top";
import { PrBatcher } from "./pr-batch";
import { createWorklistRefresher } from "./server-worklist";
import { finishWorklist } from "./worklist-data";
import type { PrListCache, PrListKind } from "./prlist-data";
import { cachedClaimedPrs, prefetchFor } from "./server-prs";
import { log } from "./util";
import { overbridgeBuildTime, overbridgeVersion, parseBuildTime, shouldReplace } from "./version";

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

/** Long enough to share one read between callers that ask together, short of the panes' 60 s refresh. */
export const PRLIST_TTL_MS = 30_000;
export const PRLIST_STALE_MS = 30 * 60_000;

/** How often the server checks whether the sweep is due. */
export const SWEEP_TICK_MS = 5_000;
export const IDLE_EXIT_MS = 10 * 60_000;

/** Refreshes running at once: each runs `gh` calls of its own. */
export const MAX_REFRESHES = 4;

/** One PR from the shared batch: null when GitHub has no such PR, undefined when the batch cut it short; `error` when it is stale. */
export interface BatchedPrView {
  view: PrView | null | undefined;
  error?: string;
}

export interface HandlerDeps {
  refreshTop: (ws: string, o?: { force?: boolean }) => Promise<TopCache>;
  /** Build every perf view and write `perf.json`; resolves with when it was built (a cached value cannot be undefined). */
  refreshPerf: () => Promise<number>;
  /** Refresh the work list (`worklist.json`); resolves with when. Absent: the route answers 404 and the pane runs a child. */
  refreshWorklist?: (force: boolean) => Promise<number>;
  worklistStats?: () => object;
  /** Refresh a PR list (`prlist-<kind>.json`); resolves with when it was read. Absent: the route answers 404 and the pane runs a child. */
  refreshPrList?: (kind: PrListKind, force: boolean) => Promise<number>;
  /** One PR's view from the shared batch, for `overbridge pr-checks`; null when GitHub has no such PR. Absent: `GET /pr-checks` answers 404. */
  prView?: (repo: string, pr: number) => Promise<BatchedPrView>;
  workspaceExists: (ws: string) => boolean;
  /** When `ws`'s top cache file was last written (ms since epoch), 0 when it has none. */
  cacheFileAt: (ws: string) => number;
  version: string;
  /** What the PR batcher has done, for `/status`. */
  prBatch?: () => object;
  prBusy?: () => boolean;
  worklistBusy?: () => boolean;
  /** The rate-limit gate's state for `/status`. */
  rateStats?: () => object;
  /** The sweep timer's counters; present when the server runs the merged-PR sweep. `GET /sweep` answers 404 without it. */
  sweepStats?: () => object;
  sweepBusy?: () => boolean;
  /** This build's time (seconds since epoch), when it has one; a server without it is replaced only by a later release. */
  buildTime?: number;
  /** Whether an upgrade removed the file this server loads its refresh worker from. */
  workerFileGone?: () => boolean;
  /** Called when a client of a newer build calls, or the server's code is gone: finish what is running, then exit. */
  onVersionMismatch: () => void;
  /** Where a failed refresh is reported; the server's own stdio is ignored. */
  log?: (msg: string) => void;
  now?: () => number;
}

/** The body of `GET /status`: the server's counters and what each optional part reports. */
interface StatusBody extends CacheStats {
  version: string;
  pid: number;
  uptimeMs: number;
  draining: boolean;
  subscribers: number;
  perf: CacheStats;
  prBatch?: object;
  worklist?: object;
  sweep?: object;
  rateLimit?: object;
}

/** The reply to a forced or queued refresh: when the served value was built, and the error that left it stale. */
interface ServedBody {
  ws?: string;
  served: Served;
  error?: string;
}

const servedBody = (served: Served, error: string | undefined, ws?: string): ServedBody => {
  const body: ServedBody = ws === undefined ? { served } : { ws, served };

  if (error) body.error = error;

  return body;
};

const json = <Body extends object>(status: number, body: Body) => Response.json(body, { status });

/** The routes, apart from the socket, so tests call them directly. */
export function createHandler(deps: HandlerDeps) {
  const now = deps.now ?? Date.now;
  const report = deps.log ?? (() => undefined);
  const cache = new Cache<TopCache>({ maxInFlight: MAX_REFRESHES, now, onError: (key, e) => report(`${key}: ${e.message}`) });
  const perf = new Cache<number>({ maxInFlight: 1, now, onError: (key, e) => report(`${key}: ${e.message}`) });
  const lists = new Cache<number>({ maxInFlight: 2, now, onError: (key, e) => report(`${key}: ${e.message}`) });
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

    // `/status` reads no worker, so it keeps answering and `overbridge server status` still works until the server exits
    if (url.pathname !== "/status" && deps.workerFileGone?.()) {
      // an upgrade deleted this server's files, so every worker it starts fails: go, and the caller's next call starts the installed version
      if (!draining) {
        report(WORKER_GONE_MESSAGE);
        draining = true;
        deps.onVersionMismatch();
      }

      return json(503, { error: "server code was removed by an upgrade; restarting" });
    }

    if (theirs && theirs !== deps.version) {
      // only a client of a newer build may replace this server, so builds running side by side (an older pane that
      // outlived an upgrade, a dev checkout) cannot keep killing each other's server
      if (shouldReplace({ version: theirs, buildTime: parseBuildTime(req.headers.get(BUILD_HEADER) ?? undefined) }, { version: deps.version, buildTime: deps.buildTime })) {
        draining = true;
        deps.onVersionMismatch();
      }

      return json(409, { error: "version mismatch", server: deps.version, client: theirs });
    }

    if (req.method === "GET" && url.pathname === "/status") {
      const status: StatusBody = { version: deps.version, pid: process.pid, uptimeMs: now() - startedAt, draining, subscribers: events.count, ...cache.stats(), perf: perf.stats() };

      if (deps.prBatch) status.prBatch = deps.prBatch();

      if (deps.worklistStats) status.worklist = deps.worklistStats();

      if (deps.sweepStats) status.sweep = deps.sweepStats();

      if (deps.rateStats) status.rateLimit = deps.rateStats();

      return json(200, status);
    }

    if (req.method === "GET" && url.pathname === "/events") {
      return eventStream();
    }

    if (req.method === "GET" && url.pathname === "/sweep" && deps.sweepStats) {
      // a sidebar asks this to learn the server runs the sweep, so it skips its own
      return json(200, { owner: true, ...deps.sweepStats() });
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

        return json(200, servedBody(served, error));
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

    if (req.method === "GET" && url.pathname === "/pr-checks" && deps.prView) {
      const repo = url.searchParams.get("repo") ?? "";
      const pr = Number(url.searchParams.get("pr"));

      if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(pr) || pr <= 0) return json(400, { error: "pass repo=<owner/name> and pr=<number>" });

      try {
        const { view, error } = await deps.prView(repo, pr);
        // no `view` is a PR the batch cut short (too many checks or threads): the client reads it from GitHub itself
        const body = view === undefined ? {} : { view };

        return json(200, error ? { ...body, error } : body);
      } catch (e) {
        return json(502, { error: errorText(e) });
      }
    }

    const list = /^\/refresh\/prlist\/(prs|reviews)$/.exec(url.pathname);

    if (req.method === "POST" && list && deps.refreshPrList) {
      const kind = list[1] === "prs" ? "prs" : "reviews";
      const refreshList = deps.refreshPrList;

      try {
        const { served, error } = await lists.get(`prlist:${kind}`, async () => {
          const at = await refreshList(kind, url.searchParams.get("force") === "1");
          events.publish(`prlist:${kind}`);

          return at;
        }, { ttlMs: PRLIST_TTL_MS, staleMs: PRLIST_STALE_MS, force: url.searchParams.get("force") === "1" });

        return json(200, servedBody(served, error));
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

        return json(200, servedBody(served, error, ws));
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
    /** Mark the server as draining, so `GET /status` shows it while running work finishes. */
    drain: () => {
      draining = true;
    },
    /** End every event stream, so a client reconnects to whichever server runs next. */
    closeStreams: () => [...streams].forEach((close) => close()),
    busy: () => cache.busy || perf.busy || lists.busy || (deps.prBusy?.() ?? false) || (deps.worklistBusy?.() ?? false) || (deps.sweepBusy?.() ?? false),
  };
}

interface WorkerReply {
  ok: boolean;
  value?: unknown;
  cache?: TopCache;
  at?: number;
  /** A rate-limit failure seen inside the job. */
  limited?: string;
  error?: string;
}

/**
 * One job in a worker thread of `file`: resolves with `pick` of its reply, or rejects with the error text it sent, with
 * `fallback` when it sent none, or on timeout (`label` names the job). The worker is gone by the time this settles.
 */
function workerJob<T, Message extends object>(file: string, message: Message, o: { timeoutMs: number; label: string; fallback: string; pick: (r: WorkerReply) => T | undefined }): Promise<T> {
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

/** What the refresh worker is told: the workspace, the PRs fetched ahead for it, and why gh calls are paused, if they are. */
interface RefreshJob {
  ws: string;
  prefetched: PrefetchedPrs;
  paused?: string;
  /** The user asked for this refresh (`r`): button `status` commands run even when their last output could be reused. */
  force?: boolean;
  /** Set while the rate-limit gate is paused, even on a forced refresh that may read PRs: button `status` commands keep their last output. */
  buttonsPaused?: string;
}

/** How a top refresh runs in its worker. */
export interface RefreshOptions {
  timeoutMs?: number;
  /** Why `gh` is paused: no PR is read and the last values are kept. */
  paused?: string;
  /** Told the first rate-limit failure the worker's `gh` calls hit. */
  onLimited?: (text: string) => void;
  force?: boolean;
  buttonsPaused?: string;
}

const refreshJob = (ws: string, prefetched: PrefetchedPrs, o: RefreshOptions): RefreshJob => {
  const job: RefreshJob = { ws, prefetched };

  if (o.paused) job.paused = o.paused;

  if (o.force) job.force = true;

  if (o.buttonsPaused) job.buttonsPaused = o.buttonsPaused;

  return job;
};

const REFRESH_WORKER = "./server-worker.ts";

/** A probe and up to one full search per owner, 30 s at most each. */
const PRLIST_WORKER_TIMEOUT_MS = 150_000;
const WORKER_GONE_MESSAGE = "server code was removed by an upgrade; exiting so the next client starts the installed version";

/** Whether the refresh worker's file is gone: pnpm deletes the old package folder on upgrade while its server still runs. */
export const workerFileGone = (worker: URL = new URL(REFRESH_WORKER, import.meta.url)): boolean => !existsSync(fileURLToPath(worker));

/** What one sweep-timer tick reads and calls. */
export interface SweepTickDeps {
  exiting: () => boolean;
  workerFileGone: () => boolean;
  shutdown: () => void;
  tick: () => void;
  log: (line: string) => void;
}

/** One sweep-timer tick: sweep, or exit when an upgrade removed the worker file. */
export function sweepTick(deps: SweepTickDeps): void {
  if (deps.exiting()) {
    return;
  }

  // a server no client calls must still go, or the sweep keeps judging workspaces from caches that never refresh
  if (deps.workerFileGone()) {
    deps.log(WORKER_GONE_MESSAGE);
    deps.shutdown();

    return;
  }

  deps.tick();
}

/** Run `refreshTop` in a worker thread, so the server stays responsive while `gh` runs. */
export const refreshInWorker = (ws: string, prefetched: PrefetchedPrs = {}, o: RefreshOptions = {}): Promise<TopCache> =>
  workerJob(REFRESH_WORKER, refreshJob(ws, prefetched, o), {
    timeoutMs: o.timeoutMs ?? 120_000,
    label: `refresh of ${ws}`,
    fallback: "refresh failed",
    pick: (r) => {
      if (r.limited) o.onLimited?.(r.limited);

      return r.cache;
    },
  });

/** Build the perf views in a worker thread: it reads and folds every workspace's history, which must not stall the server. Resolves with when they were built. */
export const refreshPerfInWorker = (timeoutMs = 30_000): Promise<number> =>
  workerJob("./server-perf-worker.ts", {}, { timeoutMs, label: "perf refresh", fallback: "perf refresh failed", pick: (r) => r.at });

/** One job in a worker thread of `file`: its `{ok, value}` reply, or a rejection with the error text or on timeout. */
export const workerCall = <T, Message extends object>(file: string, message: Message, timeoutMs = 120_000): Promise<T> =>
  workerJob(file, message, {
    timeoutMs,
    label: file,
    fallback: "job failed",
    // SAFETY: the caller names T for this worker file; the worker's reply value is not checked here, so T is the caller's contract with that worker
    pick: (r) => r.value as T | undefined,
  });

/** `overbridge serve`: runs until idle, killed, its code is removed, or a client of a newer version calls. */
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

  // set while a forced worklist refresh that the gate let through is running: its board reads call `gh` despite the pause
  let worklistForced = false;

  const worklist = createWorklistRefresher({
    plan: () => workerCall("./server-worklist-worker.ts", { kind: "plan" }),
    read: async (source) => {
      const paused = source.kind === "github" && !worklistForced ? gate.message() : undefined;

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

  let refreshForSweep: (ws: string) => Promise<void> = () => Promise.resolve();

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
      worklistForced = force && gate.allowForced();
      let r;

      try {
        r = await worklist.refresh(force);
      } finally {
        worklistForced = false;
      }

      // a failed planning job serves the last timestamp with `error`; the file was not rebuilt, so the route must not answer 200
      if (r.error) throw new Error(r.error);

      return r.value;
    },
    worklistStats: () => worklist.stats(),
    refreshPrList: async (kind, force) => {
      // as the top refresh: a forced read goes past a pause once, and every failure that reads as a rate limit feeds the gate
      const forced = force && gate.allowForced();
      const paused = gate.message();

      if (paused && !forced) throw new Error(paused);
      const read = await workerCall<PrListCache, { kind: PrListKind; force: boolean }>("./server-prlist-worker.ts", { kind, force: forced }, PRLIST_WORKER_TIMEOUT_MS);

      if (read.error) {
        gate.observe(read.error);
        throw new Error(read.error);
      }

      return read.at;
    },
    worklistBusy: () => worklist.busy,
    rateStats: () => gate.stats(),
    refreshTop: async (ws, o) => {
      // a forced refresh (the user's `r`) goes past a pause once, to learn whether the limit is still on; every call that sees one feeds the gate
      const forced = o?.force === true && gate.allowForced();

      const prefetched = await prefetchFor(ws, batcher, { force: forced });
      const job: RefreshOptions = { onLimited: (text) => void gate.observe(text), force: forced };
      // a forced refresh reads PRs through a pause to learn whether it is over; the button commands call GitHub themselves, so they wait for the gate
      const paused = gate.message();

      if (paused) job.buttonsPaused = paused;

      if (paused && !forced) job.paused = paused;

      return refreshInWorker(ws, prefetched, job);
    },
    prBatch: () => batcher.stats(),
    prView: async (repo, pr) => {
      const { prs, error } = await batcher.get(repo, [pr]);

      return error ? { view: prs[pr], error } : { view: prs[pr] };
    },
    prBusy: () => batcher.busy,
    refreshPerf: refreshPerfInWorker,
    workspaceExists: (ws) => ws in readState().workspaces,
    cacheFileAt: (ws) => readTopCache(ws).at,
    log,
    version: overbridgeVersion(),
    buildTime: overbridgeBuildTime(),
    workerFileGone,
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
    handler.drain();

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
  setInterval(
    () =>
      sweepTick({
        exiting: () => exiting,
        workerFileGone,
        shutdown: () => void shutdown(),
        tick: () => void sweeper.tick(),
        log,
      }),
    SWEEP_TICK_MS,
  );
  setInterval(() => {
    if (handler.idleForMs() >= IDLE_EXIT_MS && !handler.busy()) void shutdown();
  }, 30_000);
  await new Promise<void>(() => undefined);
}
