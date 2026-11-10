import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRepo } from "./config";
import * as git from "./git";
import { wsDir } from "./paths";
import { groupAlive } from "./proc";
import type { AppSpec } from "./project-config";
import { readState } from "./state";
import { fail, run, spawnCwd } from "./util";

/**
 * Launch and teardown for the apps a repo declares in overbridge.yml. Each app
 * runs detached in its own process group, so it outlives whoever started it and
 * stops as a whole tree. Its pid and port live in
 * `<workspace>/.overbridge/apps/<repo>/<id>.json`, its output in `<id>.log`.
 */

export { groupAlive };

export const AppStatus = {
  Stopped: "stopped",
  /** running, but not answering its ready check yet */
  Starting: "starting",
  Running: "running",
  /** the record is there but its process is gone: it crashed or failed to start */
  Exited: "exited",
} as const;
export type AppStatus = (typeof AppStatus)[keyof typeof AppStatus];

export interface AppRecord {
  pid: number;
  port?: number;
  startedAtMs: number;
}

const STOP_GRACE_MS = 5_000;

const appsDir = (ws: string, repo: string) => join(wsDir(ws), ".overbridge", "apps", repo);
const recordPath = (ws: string, repo: string, id: string) => join(appsDir(ws, repo), `${id}.json`);
export const logPath = (ws: string, repo: string, id: string) => join(appsDir(ws, repo), `${id}.log`);

export function readRecord(ws: string, repo: string, id: string): AppRecord | undefined {
  const path = recordPath(ws, repo, id);
  if (!existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AppRecord>;
    const { pid = 0, port } = raw;
    // pid 0 or 1 would make a group signal hit this process's own group, or init
    if (!Number.isInteger(pid) || pid <= 1) return;
    return { pid, ...(typeof port === "number" ? { port } : {}), startedAtMs: raw.startedAtMs ?? 0 };
  } catch {
    return;
  }
}

/**
 * A process's state letter ("R", "S", "Z"...), or undefined when it is gone.
 * `kill(pid, 0)` is not enough: it succeeds on a zombie, which is what a child
 * of this process stays until something reaps it.
 */
function procState(pid: number): string | undefined {
  try {
    // "<pid> (<comm>) <state> ..."; comm may contain spaces and parens, so cut at the last ")"
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
  } catch {
    if (existsSync("/proc/self")) return;
  }
  const r = run(["ps", "-o", "stat=", "-p", String(pid)]);
  return r.ok && r.stdout ? r.stdout.slice(0, 1) : undefined;
}

/** True while the process exists and has not exited (zombies count as exited). */
export const processAlive = (pid: number): boolean => {
  const state = procState(pid);
  return state !== undefined && state !== "Z";
};

/** Replace `{port}` in a command or url. */
export const withPort = (text: string, port?: number): string => text.replaceAll("{port}", String(port ?? ""));

/** Whether nothing is listening on `port` right now. */
export function portFree(port: number): boolean {
  try {
    Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
}

export interface Holder {
  ws: string;
  port?: number;
}

/** Workspaces currently running `repo`'s app `id`. */
export function holders(repo: string, id: string): Holder[] {
  return Object.keys(readState().workspaces).flatMap((ws) => {
    const record = readRecord(ws, repo, id);
    return record && processAlive(record.pid) ? [{ ws, port: record.port }] : [];
  });
}

/** The first pool port nobody holds. Fails naming the holders when the pool is used up. */
export function allocatePort(spec: AppSpec, repo: string): number | undefined {
  if (spec.ports.length === 0) return;
  const held = holders(repo, spec.id);
  const taken = new Set(held.map((h) => h.port));
  const port = spec.ports.find((p) => !taken.has(p) && portFree(p));
  if (port !== undefined) return port;
  const who = held.length ? `held by ${held.map((h) => `${h.ws}:${h.port}`).join(", ")}` : "in use by other processes";
  return fail(`no free port for ${spec.id} (${spec.ports.join(", ")}): ${who}`);
}

/** `when: feature-branch` apps are offered only off the repo's default branch. */
export function appAvailable(spec: AppSpec, repo: string, repoDir: string): boolean {
  if (spec.when === "always") return true;
  const branch = git.currentBranch(repoDir);
  return branch !== undefined && branch !== git.defaultBranch(getRepo(repo));
}

const appCwd = (spec: AppSpec, repoDir: string) => join(repoDir, spec.dir);

/** Start the app detached. Returns its record. Fails if it is already running or no port is free. */
export function startApp(ws: string, repo: string, spec: AppSpec, repoDir: string): AppRecord {
  const existing = readRecord(ws, repo, spec.id);
  if (existing && processAlive(existing.pid)) fail(`${spec.id} is already running in ${ws} (pid ${existing.pid})`);
  if (!appAvailable(spec, repo, repoDir)) fail(`${spec.id} only runs on a feature branch; ${repo} is on its default branch`);

  const port = allocatePort(spec, repo);
  mkdirSync(appsDir(ws, repo), { recursive: true });
  rmSync(recordPath(ws, repo, spec.id), { force: true });

  const cwd = appCwd(spec, repoDir);
  const log = openSync(logPath(ws, repo, spec.id), "w");
  try {
    if (spec.prepare) {
      const p = Bun.spawnSync({ cmd: ["sh", "-c", withPort(spec.prepare, port)], cwd, stdout: log, stderr: log, stdin: "ignore" });
      if (p.exitCode !== 0) fail(`${spec.id}: prepare failed (exit ${p.exitCode}); see ${logPath(ws, repo, spec.id)}`);
    }
    const proc = Bun.spawn({
      cmd: ["sh", "-c", withPort(spec.start, port)],
      cwd,
      stdout: log,
      stderr: log,
      stdin: "ignore",
      detached: true,
    });
    proc.unref();
    const record: AppRecord = { pid: proc.pid, ...(port !== undefined ? { port } : {}), startedAtMs: Date.now() };
    writeFileSync(recordPath(ws, repo, spec.id), JSON.stringify(record) + "\n");
    return record;
  } finally {
    closeSync(log);
  }
}

/** Stop the app: run its `stop` command if it has one, then make sure the whole process group is gone. */
export function stopApp(ws: string, repo: string, spec: AppSpec, repoDir: string): boolean {
  const record = readRecord(ws, repo, spec.id);
  if (!record) return false;
  if (spec.stop) {
    const r = run(["sh", "-c", withPort(spec.stop, record.port)], { cwd: appCwd(spec, repoDir) });
    if (!r.ok) fail(`${spec.id}: stop command failed (exit ${r.code}): ${r.stderr || r.stdout}`);
  }
  killGroup(record.pid);
  rmSync(recordPath(ws, repo, spec.id), { force: true });
  return true;
}

function killGroup(pid: number) {
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      // group already gone
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + STOP_GRACE_MS;
  while (groupAlive(pid) && Date.now() < deadline) Bun.sleepSync(50);
  if (groupAlive(pid)) {
    signal("SIGKILL");
    while (groupAlive(pid) && Date.now() < deadline + 2_000) Bun.sleepSync(50);
  }
}

/** The url a ready check or the browser should hit. */
export function appUrl(spec: AppSpec, port?: number): string | undefined {
  if (spec.ready?.kind === "http") return withPort(spec.ready.url, port);
  return port !== undefined ? `http://localhost:${port}` : undefined;
}

/** True when the app answers: any HTTP response counts, and for tcp a connection. */
export async function isReady(spec: AppSpec, port?: number): Promise<boolean> {
  const ready = spec.ready;
  if (!ready) return true;
  try {
    if (ready.kind === "http") {
      await fetch(withPort(ready.url, port), { signal: AbortSignal.timeout(1_000), redirect: "manual" });
      return true;
    }
    const target = ready.port ?? port;
    if (target === undefined) return false;
    const socket = await Bun.connect({ hostname: "127.0.0.1", port: target, socket: { data() {}, open() {}, close() {}, error() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

export async function appStatus(ws: string, repo: string, spec: AppSpec): Promise<AppStatus> {
  const record = readRecord(ws, repo, spec.id);
  if (!record) return AppStatus.Stopped;
  if (!processAlive(record.pid)) return AppStatus.Exited;
  return (await isReady(spec, record.port)) ? AppStatus.Running : AppStatus.Starting;
}

/** Wait until the app answers. Gives up when its process dies or `timeoutMs` passes. */
export async function waitReady(spec: AppSpec, record: AppRecord, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReady(spec, record.port)) return true;
    if (!processAlive(record.pid)) return false;
    await Bun.sleep(250);
  }
  return false;
}

/** Open `url` in the user's browser; best effort. */
export function openBrowser(url: string) {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    Bun.spawn({ cmd: [opener, url], cwd: spawnCwd(), stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
  } catch {
    // no opener installed
  }
}
