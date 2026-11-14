import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root, selfCommand } from "./paths";
import { overbridgeVersion } from "./version";

/**
 * The client half of the server, on node builtins only: the agent hook imports it, and the hook runs on every tool
 * call. `server-client.ts` builds the richer calls (refresh and wait for the cache) on top.
 */

/** sockaddr_un holds 104 bytes on macOS (108 on Linux); stay under the smaller. */
const SOCKET_PATH_MAX = 104;
/** A client starts the server at most this often. */
export const START_LOCK_MS = 30_000;
export const VERSION_HEADER = "x-overbridge-version";
/** When the calling process started (ms since epoch): only a client newer than the server may replace it. */
export const CLIENT_START_HEADER = "x-overbridge-client-start";
/** Set to anything non-empty to keep every caller on its own refresh and never start the server. */
export const serverDisabled = (): boolean => !!process.env.OVERBRIDGE_NO_SERVER;

const metaOf = () => join(root(), ".overbridge");
export const pidFile = () => join(metaOf(), "server.pid");
/** Written by `overbridge server stop`, so the watchdog does not bring back a server the user stopped. */
export const stoppingFile = () => join(metaOf(), "server.stopping");

/** `<meta>/server.sock`, or a short path under the runtime dir when that would not fit. */
export function socketPath(rootDir: string = root()): string {
  const direct = join(rootDir, ".overbridge", "server.sock");
  if (Buffer.byteLength(direct) < SOCKET_PATH_MAX) return direct;
  const hash = createHash("sha1").update(rootDir).digest("hex").slice(0, 12);
  // the uid keeps another user on a shared /tmp from binding the name first
  return join(process.env.XDG_RUNTIME_DIR || tmpdir(), `overbridge-${process.getuid?.() ?? 0}-${hash}.sock`);
}

const PROCESS_START_MS = Date.now() - process.uptime() * 1000;

export interface Reply {
  status: number;
  body: string;
}

/**
 * One HTTP call over the server's socket. Resolves `undefined` when nothing answers (no socket, refused, timed out),
 * so the caller falls back to its local path.
 */
export function call(method: string, path: string, o: { timeoutMs: number; sock?: string; version?: string; startedAtMs?: number }): Promise<Reply | undefined> {
  if (serverDisabled()) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: Reply | undefined) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    try {
      const req = request(
        { socketPath: o.sock ?? socketPath(), method, path, agent: false, headers: { [VERSION_HEADER]: o.version ?? overbridgeVersion(), [CLIENT_START_HEADER]: String(o.startedAtMs ?? PROCESS_START_MS), connection: "close" }, timeout: o.timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
          res.on("error", () => done(undefined));
        },
      );
      req.on("timeout", () => {
        req.destroy();
        done(undefined);
      });
      req.on("error", () => done(undefined));
      req.end();
    } catch {
      done(undefined);
    }
  });
}

/** Whether a start was attempted within `START_LOCK_MS`; if not, records one now. */
export function claimStart(now = Date.now()): boolean {
  const file = join(metaOf(), "server.start");
  try {
    if (now - statSync(file).mtimeMs < START_LOCK_MS) return false;
  } catch {
    // never started
  }
  try {
    mkdirSync(metaOf(), { recursive: true });
    closeSync(openSync(file, "a"));
    utimesSync(file, now / 1000, now / 1000);
  } catch {
    return false;
  }
  return true;
}

/** Start `overbridge serve` detached, at most once per `START_LOCK_MS` across every client. */
export function startServer(spawn: (cmd: string[]) => void = defaultSpawn, now = Date.now()): boolean {
  if (serverDisabled() || !claimStart(now)) return false;
  try {
    spawn([...selfCommand(), "serve"]);
    return true;
  } catch {
    return false;
  }
}

/** Start `overbridge serve` detached now, past the start throttle: `overbridge server restart` is the user asking. */
export function spawnServer(): void {
  defaultSpawn([...selfCommand(), "serve"]);
}

function defaultSpawn(cmd: string[]) {
  Bun.spawn({ cmd, cwd: process.env.HOME ?? "/", stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
}

/**
 * Ask the server to refresh `ws`'s top cache; it answers at once and refreshes behind the reply. False when no server
 * took the request (none answered, and one is being started; or it refused), so the hook refreshes on its own.
 */
export async function notifyRefresh(ws: string, o: { sock?: string; timeoutMs?: number; start?: boolean } = {}): Promise<boolean> {
  const r = await call("POST", `/refresh/top/${encodeURIComponent(ws)}?async=1`, { timeoutMs: o.timeoutMs ?? 500, ...(o.sock ? { sock: o.sock } : {}) });
  if (!r && o.start !== false) startServer();
  return r?.status === 202;
}

const PID_WRITE_GRACE_MS = 2_000;

/** Write `pid` into `file` if no live process holds it. Returns false when one does. */
export function takePidFile(file: string, alive: (pid: number) => boolean, pid = process.pid): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(pid), { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = Number(readFileSync(file, "utf8"));
      // an empty file is a server that created it a moment ago and has not written its pid yet
      if (!holder && Date.now() - statSync(file).mtimeMs < PID_WRITE_GRACE_MS) return false;
      if (holder && holder !== pid && alive(holder)) return false;
      // stale: its process is gone
      rmSync(file, { force: true });
    }
  }
  return false;
}
