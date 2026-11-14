import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { pidAlive, readProc } from "./proc";
import { call, pidFile, socketPath, spawnServer, stoppingFile } from "./server-net";
import { OverbridgeError } from "./util";

/** `overbridge server status|stop|restart`: look at, stop and restart the long-running server. */

interface KeyCounters {
  atMs?: number;
  hits?: number;
  misses?: number;
  inFlight?: boolean;
  failures?: number;
  error?: string;
  lastError?: string;
  lastErrorAtMs?: number;
  retryAtMs?: number;
}
type Keys = Record<string, KeyCounters>;

/** The body of `GET /status`, as far as this command reads it. */
export interface ServerStatus {
  version?: string;
  pid?: number;
  uptimeMs?: number;
  draining?: boolean;
  subscribers?: number;
  hits?: number;
  misses?: number;
  shared?: number;
  fetches?: number;
  inFlight?: number;
  queued?: number;
  keys?: Keys;
  perf?: { keys?: Keys };
  prBatch?: { calls?: number; prs?: number; points?: number; cache?: { keys?: Keys } };
  worklist?: { run?: { keys?: Keys }; boards?: { keys?: Keys } };
  sweep?: { runs?: number; running?: boolean; lastAt?: number; lastMs?: number; lastChecked?: number; lastError?: string };
  rateLimit?: { paused?: boolean; untilMs?: number; trips?: number; message?: string };
}

export function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

const ago = (at: number | undefined, now: number) => (at ? `${duration(now - at)} ago` : "never");

/** The per-key rows, across every cache the server keeps, sorted by key. */
export function keyRows(s: ServerStatus): Array<[string, KeyCounters]> {
  const all: Keys = { ...s.keys, ...s.perf?.keys, ...s.prBatch?.cache?.keys, ...s.worklist?.run?.keys, ...s.worklist?.boards?.keys };
  return Object.entries(all).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The text `overbridge server status` prints. */
export function formatStatus(s: ServerStatus, now: number = Date.now()): string {
  const lines = [`overbridge server ${s.version ?? "?"}  pid ${s.pid ?? "?"}  up ${duration(s.uptimeMs ?? 0)}${s.draining ? "  draining" : ""}  subscribers ${s.subscribers ?? 0}`];
  const rate = s.rateLimit;
  lines.push(rate?.paused ? `gh: ${rate.message ?? "paused by a GitHub rate limit"}` : `gh: ok${rate?.trips ? ` (rate limit hit ${rate.trips}x)` : ""}`);
  lines.push(`cache: ${s.hits ?? 0} hits, ${s.misses ?? 0} misses, ${s.shared ?? 0} shared, ${s.fetches ?? 0} fetches, ${s.inFlight ?? 0} in flight, ${s.queued ?? 0} queued`);
  if (s.prBatch) lines.push(`pr batch: ${s.prBatch.calls ?? 0} calls, ${s.prBatch.prs ?? 0} PRs, ${s.prBatch.points ?? 0} points`);
  if (s.sweep) lines.push(`sweep: ${s.sweep.runs ?? 0} runs, last ${ago(s.sweep.lastAt, now)}${s.sweep.running ? " (running)" : ""}${s.sweep.lastError ? `, last error: ${s.sweep.lastError}` : ""}`);
  const rows = keyRows(s);
  if (rows.length) {
    const width = Math.max(...rows.map(([k]) => k.length));
    lines.push("", "keys:");
    for (const [key, c] of rows) {
      const err = c.lastError ? `  last error ${ago(c.lastErrorAtMs, now)}: ${c.lastError}` : "";
      lines.push(`  ${key.padEnd(width)}  hits ${c.hits ?? 0}  misses ${c.misses ?? 0}  ${c.inFlight ? "in flight" : "idle"}  fetched ${ago(c.atMs, now)}${err}`);
    }
  }
  return lines.join("\n");
}

/** Ask the running server for its status; undefined when none answers. */
export async function readStatus(sock?: string): Promise<ServerStatus | undefined> {
  // no version: a server of another version still answers, and this look must never make it drain
  const r = await call("GET", "/status", { timeoutMs: 3_000, version: "", ...(sock ? { sock } : {}) });
  if (!r || r.status !== 200) return undefined;
  try {
    return JSON.parse(r.body) as ServerStatus;
  } catch {
    return undefined;
  }
}

function pidFromFile(): number | undefined {
  try {
    const pid = Number(readFileSync(pidFile(), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Looks like a process this tool starts: a pid file outlives a crash, and the OS may hand its pid to anything. */
const looksLikeServer = (pid: number): boolean => /bun|overbridge|node/i.test(readProc(pid)?.comm ?? "");

/**
 * The server to act on. One that answers names its own pid, which is the only pid fully trusted. Failing that, the pid file's
 * process counts only while it is alive and looks like ours (a hung server answers nothing); anything else is a stale file.
 */
async function findServer(): Promise<number | undefined> {
  const status = await readStatus();
  if (status?.pid !== undefined) return status.pid;
  const pid = pidFromFile();
  return pid !== undefined && pidAlive(pid) && looksLikeServer(pid) ? pid : undefined;
}

const signal = (pid: number, sig: NodeJS.Signals): boolean => {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    // gone between the look and the signal (ESRCH), or not ours to signal (EPERM)
    return false;
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const clearFiles = () => {
  rmSync(pidFile(), { force: true });
  rmSync(socketPath(), { force: true });
};

/**
 * Stop the server: SIGTERM, which lets it finish what runs, then wait. After `graceMs` a server that has not gone (a hung one)
 * is killed when `escalate` is set; otherwise this reports that it did not stop. Returns whether it is gone. While it runs a
 * marker tells the watchdog not to bring the server back.
 */
export async function stopServer(o: { graceMs?: number; escalate?: boolean; say?: (msg: string) => void } = {}): Promise<boolean> {
  const say = o.say ?? (() => undefined);
  const pid = await findServer();
  if (pid === undefined) {
    // nothing of ours alive: clear what a crash left behind so the next start is clean
    clearFiles();
    return true;
  }
  writeFileSync(stoppingFile(), String(pid));
  try {
    signal(pid, "SIGTERM");
    const end = Date.now() + (o.graceMs ?? 15_000);
    while (Date.now() < end && pidAlive(pid)) await sleep(100);
    if (pidAlive(pid)) {
      if (!o.escalate) return false;
      say(`server ${pid} did not exit; killing it`);
      signal(pid, "SIGKILL");
      const killEnd = Date.now() + 5_000;
      while (Date.now() < killEnd && pidAlive(pid)) await sleep(50);
      if (pidAlive(pid)) return false;
      clearFiles();
    }
    return true;
  } finally {
    // gone, or still up and no longer being stopped: either way the watchdog may act again
    rmSync(stoppingFile(), { force: true });
  }
}

/** Start the server (past the start throttle) and wait until it answers. */
export async function startAndWait(timeoutMs = 10_000): Promise<ServerStatus | undefined> {
  spawnServer();
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await readStatus();
    if (s) return s;
    await sleep(100);
  }
  return undefined;
}

export async function serverCommand(args: string[], out: (text: string) => void = console.log): Promise<number> {
  const [sub, ...flags] = args;
  const json = flags.includes("--json");
  const force = flags.includes("--force");
  switch (sub) {
    case "status": {
      const s = await readStatus();
      if (!s) {
        out("server not running");
        return 1;
      }
      out(json ? JSON.stringify(s, null, 2) : formatStatus(s));
      return 0;
    }
    case "stop": {
      const wasUp = (await findServer()) !== undefined;
      if (!(await stopServer({ escalate: force, say: out }))) {
        out("server did not stop in time; it may be busy. `overbridge server stop --force` kills it");
        return 1;
      }
      out(wasUp ? "server stopped" : "server not running");
      return 0;
    }
    case "restart": {
      await stopServer({ escalate: true, say: out });
      const s = await startAndWait();
      if (!s) {
        out("server did not come back; run `overbridge serve` to see why");
        return 1;
      }
      out(`server restarted, pid ${s.pid ?? "?"}`);
      return 0;
    }
    default:
      throw new OverbridgeError("usage: overbridge server status [--json] | stop [--force] | restart");
  }
}
