import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { NAME_RE, metaDir } from "./paths";
import { pidAlive } from "./proc";
import { Cache } from "./server-cache";
import { pidFile, socketPath, takePidFile, VERSION_HEADER } from "./server-net";
import { readState } from "./state";
import type { TopCache } from "./top";
import { log } from "./util";
import { overbridgeVersion } from "./version";

/**
 * `overbridge serve`: one process per workspaces root that owns the network refreshes and serves one cache over HTTP on
 * a unix socket. Panes still read the cache files; the server is a faster, coordinated writer of them. It keeps no
 * durable state, so a crash, kill or upgrade loses nothing that one refresh does not rebuild.
 */

export const TOP_TTL_MS = 60_000;
export const TOP_STALE_MS = 10 * 60_000;
/** A forced refresh of one workspace is honoured at most this often. */
export const FORCE_GAP_MS = 5_000;
export const IDLE_EXIT_MS = 10 * 60_000;
/** Refreshes running at once: each runs `gh` calls of its own. */
export const MAX_REFRESHES = 4;

export interface HandlerDeps {
  refreshTop: (ws: string) => Promise<TopCache>;
  workspaceExists: (ws: string) => boolean;
  version: string;
  /** Called after a request from a client of another version: finish what is running, then exit. */
  onVersionMismatch: () => void;
  now?: () => number;
}

const json = (status: number, body: unknown) => Response.json(body, { status });

/** The routes, apart from the socket, so tests call them directly. */
export function createHandler(deps: HandlerDeps) {
  const now = deps.now ?? Date.now;
  const cache = new Cache<TopCache>({ maxInFlight: MAX_REFRESHES, now });
  const startedAt = now();
  let lastRequestAt = now();
  let draining = false;

  async function handle(req: Request): Promise<Response> {
    lastRequestAt = now();
    const url = new URL(req.url);
    const theirs = req.headers.get(VERSION_HEADER);
    if (theirs && theirs !== deps.version) {
      draining = true;
      deps.onVersionMismatch();
      return json(409, { error: "version mismatch", server: deps.version, client: theirs });
    }
    if (req.method === "GET" && url.pathname === "/status") {
      return json(200, { version: deps.version, pid: process.pid, uptimeMs: now() - startedAt, draining, ...cache.stats() });
    }
    const top = /^\/refresh\/top\/([^/]+)$/.exec(url.pathname);
    if (req.method === "POST" && top) {
      const ws = decodeURIComponent(top[1]!);
      if (!NAME_RE.test(ws) || !deps.workspaceExists(ws)) return json(404, { error: `no workspace ${ws}` });
      const got = cache.get(`top:${ws}`, () => deps.refreshTop(ws), {
        ttlMs: TOP_TTL_MS,
        staleMs: TOP_STALE_MS,
        force: url.searchParams.get("force") === "1",
        minForceGapMs: FORCE_GAP_MS,
      });
      if (url.searchParams.get("async") === "1") {
        got.catch(() => undefined);
        return json(202, { queued: ws });
      }
      try {
        const { served, error } = await got;
        return json(200, { ws, served, ...(error ? { error } : {}) });
      } catch (e) {
        return json(502, { error: (e as Error).message });
      }
    }
    return json(404, { error: "not found" });
  }

  return {
    handle,
    stats: () => cache.stats(),
    idleFor: () => now() - lastRequestAt,
    busy: () => cache.busy,
  };
}

/** Run `refreshTop` in a worker thread, so the server stays responsive while `gh` runs. */
export function refreshInWorker(ws: string, timeoutMs = 120_000): Promise<TopCache> {
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
    worker.postMessage({ ws });
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
  const handler = createHandler({
    refreshTop: refreshInWorker,
    workspaceExists: (ws) => ws in readState().workspaces,
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
    // the umask already did it
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
    if (handler.idleFor() >= IDLE_EXIT_MS && !handler.busy()) void shutdown();
  }, 30_000);
  await new Promise<void>(() => undefined);
}
