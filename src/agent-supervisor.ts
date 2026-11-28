import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonNumber, isJsonObject, numberField, parseJson, stringField, type JsonValue } from "./json";
import { metaDir } from "./paths";
import type { Proc } from "./proc";

/**
 * The protocol between `overbridge relaunch` and the `overbridge claude` supervisor: the launcher and request files
 * under `<meta>/agent`, the signal, and the process-tree lookups.
 */

/** Whether a relaunch resumes the agent's last conversation or starts a new one. */
export const SessionMode = { Continue: "continue", Fresh: "fresh" } as const;

export type SessionMode = (typeof SessionMode)[keyof typeof SessionMode];

/** The running `overbridge claude` supervisor of a workspace and its agent's pid. */
export interface Launcher {
  pid: number;
  child: number;
}

/** What the supervisor does once its agent exits after `overbridge relaunch` asked. */
export interface RelaunchRequest {
  session: SessionMode;
  /** The new agent's first message. */
  prompt: string;
  requestedAtMs: number;
}

/** A request older than this is left over from a relaunch that never happened, and is ignored. */
export const REQUEST_MAX_AGE_MS = 60_000;

/** The signal `relaunch` sends the supervisor (SIGUSR1 can start a debugger in a JS runtime). */
export const RELAUNCH_SIGNAL = "SIGUSR2";

export const launcherPath = (ws: string, meta = metaDir()) => join(meta, "agent", `${ws}.launcher.json`);
export const relaunchRequestPath = (ws: string, meta = metaDir()) => join(meta, "agent", `${ws}.relaunch.json`);

function writeAtomic(file: string, value: Launcher | RelaunchRequest) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value) + "\n");
  renameSync(tmp, file);
}

function readObject(file: string) {
  try {
    const raw = parseJson(readFileSync(file, "utf8"));

    return isJsonObject(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

export const writeLauncher = (ws: string, l: Launcher) => writeAtomic(launcherPath(ws), l);

export function readLauncher(ws: string): Launcher | undefined {
  const raw = readObject(launcherPath(ws));
  const pid = raw && numberField(raw, "pid");
  const child = raw && numberField(raw, "child");

  return pid !== undefined && child !== undefined ? { pid, child } : undefined;
}

/** Remove the launcher file when it still names `pid`, so a newer supervisor's file is never removed. */
export function clearLauncher(ws: string, pid: number) {
  if (readLauncher(ws)?.pid === pid) {
    rmSync(launcherPath(ws), { force: true });
  }
}

export const writeRelaunchRequest = (ws: string, r: RelaunchRequest) => writeAtomic(relaunchRequestPath(ws), r);

/** Parse a stored request; undefined when it is malformed or older than `REQUEST_MAX_AGE_MS`. */
export function parseRelaunchRequest(raw: JsonValue | undefined, now: number): RelaunchRequest | undefined {
  if (!isJsonObject(raw)) return undefined;
  const session = Object.values(SessionMode).find((m) => m === raw.session);
  const prompt = stringField(raw, "prompt");
  const requestedAtMs = isJsonNumber(raw.requestedAtMs) ? raw.requestedAtMs : undefined;

  if (!session || prompt === undefined || requestedAtMs === undefined || now - requestedAtMs > REQUEST_MAX_AGE_MS) return undefined;

  return { session, prompt, requestedAtMs };
}

/** Read and delete the request, so it applies to one restart only. */
export function takeRelaunchRequest(ws: string, now = Date.now()): RelaunchRequest | undefined {
  const file = relaunchRequestPath(ws);
  const raw = readObject(file);
  rmSync(file, { force: true });

  return parseRelaunchRequest(raw, now);
}

/** The agent's extra argv for a relaunch, in the shape `overbridge claude <ws> -- ...` passes on. */
export const relaunchExtra = (r: RelaunchRequest): string[] => [...(r.session === SessionMode.Continue ? ["--continue"] : []), "--", r.prompt];

/** `pid` and its ancestors, nearest first, stopping at pid 1, a loop, or after 64 steps. */
export function ancestry(pid: number, parentOf: (pid: number) => number | undefined): number[] {
  const walk = (p: number | undefined, seen: readonly number[]): number[] =>
    p === undefined || p <= 1 || seen.includes(p) || seen.length >= 64 ? [...seen] : walk(parentOf(p), [...seen, p]);

  return walk(pid, []);
}

/** The workspace whose supervisor is in `chain`: the one a process with that ancestry runs under. */
export const workspaceAbove = (chain: readonly number[], launchers: Readonly<Record<string, Launcher>>): string | undefined =>
  Object.entries(launchers).find(([, l]) => chain.includes(l.pid))?.[0];

/** Every descendant of `pid` in `procs`, nearest first. */
export function descendants(pid: number, procs: readonly Proc[]): number[] {
  const children = procs.flatMap((p) => (p.ppid === pid ? [p.pid] : []));

  return [...children, ...children.flatMap((c) => descendants(c, procs))];
}

/**
 * Stop `ws`'s agent when its tab is not enough: the supervisor first (so it does not restart the agent), then the
 * agent. A pane the multiplexer did not close, or a removal from a shell outside the session, would otherwise leave
 * Claude running in a folder that is gone. Returns the pids signalled.
 */
export function stopAgent(ws: string, alive: (pid: number) => boolean, kill: (pid: number) => void): number[] {
  const l = readLauncher(ws);

  if (!l) return [];
  const pids = [l.pid, l.child].filter(alive);

  for (const pid of pids) {
    try {
      kill(pid);
    } catch {
      // already gone
    }
  }

  return pids;
}
