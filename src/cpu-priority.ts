import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClassTarget } from "./check-priority";
import { metaDir } from "./paths";
import type { EnvProc } from "./proc";
import { isBoolean, isNumber, isRecord, isString } from "./util";

/**
 * Each workspace's processes run at its class's nice (and, on macOS, Darwin background), so the multiplexer and the
 * sidebars, left at 0, stay above every workspace. A process belongs to the workspace its `OVERBRIDGE_NAME` names
 * where that value was set, not inherited; its descendants follow it. Only root can lower a nice value, so a class
 * that rises leaves the running processes where they are until they restart (`stuck`).
 */

/** The environment variable a workspace's agent and apps start with. */
export const WORKSPACE_ENV = "OVERBRIDGE_NAME";

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
  /** Processes never touched, on top of the multiplexers and their ancestors (the overbridge server). */
  guarded: readonly number[];
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

/** The multiplexers, everything above them, and `guarded` with its ancestors. */
export function protectedPids(procs: readonly EnvProc[], guarded: readonly number[]): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));

  return withAncestors(byPid, [...procs.flatMap((p) => (MUX_COMMANDS.has(p.comm) ? [p.pid] : [])), ...guarded]);
}

/** Each process's workspace: the nearest ancestor-or-self that set `OVERBRIDGE_NAME`, stopping at a protected process. */
export function workspaceOf(procs: readonly EnvProc[], guarded: ReadonlySet<number>): Map<number, string> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const memo = new Map<number, string | undefined>();

  const owner = (pid: number, seen: ReadonlySet<number>): string | undefined => {
    if (memo.has(pid)) {
      return memo.get(pid);
    }

    const p = byPid.get(pid);

    if (!p || guarded.has(pid) || seen.has(pid)) {
      return undefined;
    }

    const parent = byPid.get(p.ppid);
    const set = p.env !== undefined && p.env !== parent?.env;
    // an empty value (an orchestration tab) is set on purpose and means no workspace
    const found = set ? p.env || undefined : owner(p.ppid, new Set([...seen, pid]));
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
  const guarded = protectedPids(input.procs, input.guarded);
  const owners = workspaceOf(input.procs, guarded);
  const members = (ws: string) => input.procs.filter((p) => owners.get(p.pid) === ws);
  const darwin = input.policy === BackgroundPolicy.Darwin;

  const perWs = Object.entries(input.targets).map(([ws, target]) => {
    const procs = members(ws);
    const pids = new Set(procs.map((p) => p.pid));
    const lower = procs.filter((p) => p.nice < target.nice).map((p) => p.pid);
    const stuck = procs.filter((p) => p.nice > target.nice && input.classNices.includes(p.nice)).length;
    const before = input.previous[ws]?.backgroundPids ?? [];
    const background = darwin && target.background;
    const toBackground = background ? procs.map((p) => p.pid).filter((pid) => !before.includes(pid)) : [];
    const toForeground = darwin && !background ? before.filter((pid) => pids.has(pid)) : [];
    const entry: WorkspacePriority = { class: target.name, nice: target.nice, background, procs: procs.length, stuck, backgroundPids: background ? [...pids] : [] };

    return { ws, target, lower, toBackground, toForeground, entry };
  });

  const nices = [...new Set(perWs.filter((w) => w.lower.length).map((w) => w.target.nice))].toSorted((a, b) => a - b);

  return {
    renice: nices.map((nice) => ({ nice, pids: perWs.filter((w) => w.target.nice === nice).flatMap((w) => w.lower) })),
    toBackground: perWs.flatMap((w) => w.toBackground),
    toForeground: perWs.flatMap((w) => w.toForeground),
    report: { at: input.now, workspaces: Object.fromEntries(perWs.map((w) => [w.ws, w.entry])) },
  };
}

export const priorityReportPath = () => join(metaDir(), "cpu-priority.json");

const isPidList = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => isNumber(n));

const isWorkspacePriority = (v: unknown): v is WorkspacePriority =>
  isRecord(v) && isString(v.class) && isNumber(v.nice) && isBoolean(v.background) && isNumber(v.procs) && isNumber(v.stuck) && isPidList(v.backgroundPids);

/** The last pass's report; an empty one when the file is missing or unreadable, so a bad file only loses hints. */
export function readPriorityReport(file = priorityReportPath()): PriorityReport {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));

    if (!isRecord(raw) || !isNumber(raw.at) || !isRecord(raw.workspaces)) {
      return { at: 0, workspaces: {} };
    }

    return { at: raw.at, workspaces: Object.fromEntries(Object.entries(raw.workspaces).filter((e): e is [string, WorkspacePriority] => isWorkspacePriority(e[1]))) };
  } catch {
    return { at: 0, workspaces: {} };
  }
}

let cached: { file: string; mtimeMs: number; report: PriorityReport } | undefined;

/** `readPriorityReport`, read again only when the file changed, for a pane that asks on every poll. */
export function readPriorityReportCached(file = priorityReportPath()): PriorityReport {
  try {
    const { mtimeMs } = statSync(file);

    if (cached?.file !== file || cached.mtimeMs !== mtimeMs) {
      cached = { file, mtimeMs, report: readPriorityReport(file) };
    }

    return cached.report;
  } catch {
    return { at: 0, workspaces: {} };
  }
}

export function writePriorityReport(report: PriorityReport, file = priorityReportPath()) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(report) + "\n");
  renameSync(tmp, file);
}
