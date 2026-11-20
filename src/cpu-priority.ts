import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClassTarget } from "./check-priority";
import { cachedRead } from "./gauge";
import { metaDir } from "./paths";
import type { EnvProc } from "./proc";
import { isBoolean, isNumber, isRecord, isString, type Json } from "./util";

/** Only root lowers a nice, so a class that rises leaves its workspace's running processes `stuck` until they restart. */

/** The environment variable a workspace's agent and apps start with. */
export const WORKSPACE_ENV = "OVERBRIDGE_NAME";

/** The environment variable naming the root a workspace's processes belong to; two roots can share a workspace name. */
export const ROOT_ENV = "OVERBRIDGE_ROOT";

const MUX_COMMANDS: ReadonlySet<string> = new Set(["zellij", "tmux"]);

/** How Darwin background is applied: only macOS has it. */
export const BackgroundPolicy = { Darwin: "darwin", None: "none" } as const;

export type BackgroundPolicy = (typeof BackgroundPolicy)[keyof typeof BackgroundPolicy];

export const backgroundPolicy = (platform: string = process.platform): BackgroundPolicy => (platform === "darwin" ? BackgroundPolicy.Darwin : BackgroundPolicy.None);

/** What one pass found and set for a workspace. */
export interface WorkspacePriority {
  class: string;
  nice: number;
  background: boolean;
  /** How many processes belong to it. */
  procs: number;
  /** Processes still at a lower class's nice after the class rose; only a restart lowers it. */
  stuck: number;
  /** The processes this pass left in Darwin background, so a later pass can take them out. */
  backgroundPids: number[];
}

export interface PriorityReport {
  at: number;
  workspaces: Record<string, WorkspacePriority>;
}

export interface PriorityPlan {
  renice: { nice: number; pids: number[] }[];
  toBackground: number[];
  toForeground: number[];
  report: PriorityReport;
}

export interface PlanInput {
  procs: readonly EnvProc[];
  /** This root: a process that set another root's `OVERBRIDGE_ROOT` belongs to that root's workspace, not ours. */
  root: string;
  /** Processes never touched, on top of the multiplexers and their ancestors (the overbridge server). */
  extraProtected: readonly number[];
  /** Each live workspace's target; a process of any other workspace is left alone. */
  targets: Readonly<Record<string, ClassTarget>>;
  /** Every class's nice, to tell a nice this code set from one the user chose. */
  classNices: readonly number[];
  previous: PriorityReport["workspaces"];
  policy: BackgroundPolicy;
  now: number;
}

/** The pids in `start` and every ancestor of each. */
function withAncestors(byPid: ReadonlyMap<number, EnvProc>, start: readonly number[]): Set<number> {
  const out = new Set<number>();

  for (const pid of start) {
    let cur = byPid.get(pid);
    out.add(pid);

    while (cur && !out.has(cur.ppid) && byPid.has(cur.ppid)) {
      out.add(cur.ppid);
      cur = byPid.get(cur.ppid);
    }
  }

  return out;
}

/** The multiplexers, everything above them, and `extraProtected` with its ancestors. */
export function protectedPids(procs: readonly EnvProc[], extraProtected: readonly number[]): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));

  return withAncestors(byPid, [...procs.flatMap((p) => (MUX_COMMANDS.has(p.comm) ? [p.pid] : [])), ...extraProtected]);
}

/**
 * Each process's workspace: the nearest ancestor-or-self that set `OVERBRIDGE_NAME` (a value that differs from its
 * parent's, not one it inherited), stopping at a protected process.
 */
export function workspaceOf(procs: readonly EnvProc[], protectedSet: ReadonlySet<number>, root: string): Map<number, string> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const memo = new Map<number, string | undefined>();

  const owner = (pid: number, seen: ReadonlySet<number>): string | undefined => {
    if (memo.has(pid)) {
      return memo.get(pid);
    }

    const p = byPid.get(pid);

    if (!p || protectedSet.has(pid) || seen.has(pid)) {
      return undefined;
    }

    const parent = byPid.get(p.ppid);
    const setsOwnEnv = p.env !== undefined && p.env !== parent?.env;
    const foreign = p.root !== undefined && p.root !== root;
    // an empty value (an orchestration tab) is set on purpose and means no workspace
    const found = setsOwnEnv ? (foreign ? undefined : p.env || undefined) : owner(p.ppid, new Set([...seen, pid]));
    memo.set(pid, found);

    return found;
  };

  return new Map(procs.flatMap((p) => {
    const ws = owner(p.pid, new Set());

    return ws ? [[p.pid, ws] as const] : [];
  }));
}

/** What to renice and move in or out of Darwin background, and the report to keep. */
export function planPriority(input: PlanInput): PriorityPlan {
  const owners = workspaceOf(input.procs, protectedPids(input.procs, input.extraProtected), input.root);
  const members = (ws: string) => input.procs.filter((p) => owners.get(p.pid) === ws);
  const darwin = input.policy === BackgroundPolicy.Darwin;

  const perWs = Object.entries(input.targets).map(([ws, target]) => {
    const procs = members(ws);
    const pids = new Set(procs.map((p) => p.pid));
    const toRenice = procs.flatMap((p) => (p.nice < target.nice ? [p.pid] : []));
    const stuck = procs.filter((p) => p.nice > target.nice && input.classNices.includes(p.nice)).length;
    const before = input.previous[ws]?.backgroundPids ?? [];
    const background = darwin && target.background;
    const toBackground = background ? procs.map((p) => p.pid).filter((pid) => !before.includes(pid)) : [];
    const toForeground = darwin && !background ? before.filter((pid) => pids.has(pid)) : [];
    const entry: WorkspacePriority = { class: target.name, nice: target.nice, background, procs: procs.length, stuck, backgroundPids: background ? [...pids] : [] };

    return { ws, target, toRenice, toBackground, toForeground, entry };
  });

  // a workspace that had an entry but has no target now (its class is unknown) comes out of background: that is
  // reversible, where a guessed nice is not
  const orphaned = darwin
    ? Object.entries(input.previous).flatMap(([ws, w]) => (ws in input.targets ? [] : w.backgroundPids.filter((pid) => owners.get(pid) === ws)))
    : [];

  const nices = [...new Set(perWs.flatMap((w) => (w.toRenice.length ? [w.target.nice] : [])))].toSorted((a, b) => a - b);

  return {
    renice: nices.map((nice) => ({ nice, pids: perWs.filter((w) => w.target.nice === nice).flatMap((w) => w.toRenice) })),
    toBackground: perWs.flatMap((w) => w.toBackground),
    toForeground: [...perWs.flatMap((w) => w.toForeground), ...orphaned],
    report: { at: input.now, workspaces: Object.fromEntries(perWs.map((w) => [w.ws, w.entry])) },
  };
}

/**
 * `report` with each workspace's `backgroundPids` corrected for the `taskpolicy` calls that failed: a pid whose
 * `-b` failed is not in background, and one whose `-B` failed still is, so a later pass retries it. A workspace
 * that left the report keeps an entry while any of its pids is still in background.
 */
export function settleReport(report: PriorityReport, previous: PriorityReport["workspaces"], failedBackground: ReadonlySet<number>, failedForeground: ReadonlySet<number>): PriorityReport {
  const stillBackground = (ws: string) => (previous[ws]?.backgroundPids ?? []).filter((pid) => failedForeground.has(pid));

  const kept = Object.fromEntries(
    Object.entries(previous).flatMap(([ws, w]): [string, WorkspacePriority][] => (ws in report.workspaces || !stillBackground(ws).length ? [] : [[ws, { ...w, backgroundPids: stillBackground(ws) }]])),
  );

  const current = Object.fromEntries(
    Object.entries(report.workspaces).map(([ws, w]): [string, WorkspacePriority] => [ws, { ...w, backgroundPids: [...new Set([...w.backgroundPids.filter((pid) => !failedBackground.has(pid)), ...stillBackground(ws)])] }]),
  );

  return { at: report.at, workspaces: { ...kept, ...current } };
}

export const priorityReportPath = () => join(metaDir(), "cpu-priority.json");
export const priorityLockPath = () => join(metaDir(), "cpu-priority.lock");

const isPidList = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => isNumber(n));

const isWorkspacePriority = (v: unknown): v is WorkspacePriority =>
  isRecord(v) && isString(v.class) && isNumber(v.nice) && isBoolean(v.background) && isNumber(v.procs) && isNumber(v.stuck) && isPidList(v.backgroundPids);

export const emptyReport = (): PriorityReport => ({ at: 0, workspaces: {} });

/** A report from parsed JSON, keeping only the well-formed workspace entries; undefined when the shape is wrong. */
function parseReport(raw: Json): PriorityReport | undefined {
  if (!isRecord(raw) || !isNumber(raw.at) || !isRecord(raw.workspaces)) {
    return undefined;
  }

  return { at: raw.at, workspaces: Object.fromEntries(Object.entries(raw.workspaces).flatMap(([ws, w]) => (isWorkspacePriority(w) ? [[ws, w] as const] : []))) };
}

/** The last pass's report; an empty one when the file is missing or unreadable, so a bad file only loses hints. */
export function readPriorityReport(file = priorityReportPath()): PriorityReport {
  try {
    return parseReport(JSON.parse(readFileSync(file, "utf8"))) ?? emptyReport();
  } catch {
    return emptyReport();
  }
}

/** `readPriorityReport`, read again only when the file changed, for a pane that asks on every poll. */
export const readPriorityReportCached = (file = priorityReportPath()): PriorityReport => cachedRead(file, parseReport) ?? emptyReport();

export function writePriorityReport(report: PriorityReport, file = priorityReportPath()) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(report) + "\n");
  renameSync(tmp, file);
}
