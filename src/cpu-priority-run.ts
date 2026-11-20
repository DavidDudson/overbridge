import { classTarget, classTargets, type PriorityClass } from "./check-priority";
import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  backgroundPolicy,
  BackgroundPolicy,
  emptyReport,
  planPriority,
  priorityLockPath,
  type PriorityReport,
  protectedPids,
  readPriorityReport,
  ROOT_ENV,
  settleReport,
  WORKSPACE_ENV,
  workspaceOf,
  writePriorityReport,
} from "./cpu-priority";
import { root, selfCommand } from "./paths";
import { type EnvProc, listEnvProcs, pidAlive, threadIds } from "./proc";
import { loadRootLayers } from "./project-config";
import { readServerPid } from "./server-net";
import { isIceboxed, isRemoving, readState, type State } from "./state";
import { readTopCache } from "./top";
import { spawnCwd } from "./util";

/** How often the server runs a pass. */
export const PRIORITY_PASS_MS = 20_000;

export interface ApplyDeps {
  /** The root `config.yml`'s `cpu-priority`: false stops every pass. */
  enabled: () => boolean;
  /** Undefined when the process list cannot be read: the pass then changes nothing. */
  procs: () => EnvProc[] | undefined;
  /** This root, to tell our workspaces from another root's of the same name. */
  root: string;
  /** Each live workspace's class name, as its top cache last recorded it; a workspace with none yet is left out. */
  classes: () => Record<string, string>;
  priorityClasses: () => readonly PriorityClass[];
  /** Processes to leave alone besides the multiplexers: the server. */
  extraProtected: () => number[];
  /** Every thread a renice of `pid` has to reach. */
  threads: (pid: number) => number[];
  previous: () => PriorityReport;
  /** Runs `cmd`; true when it exited 0. */
  run: (cmd: string[]) => boolean;
  write: (report: PriorityReport) => void;
  policy: BackgroundPolicy;
  now: () => number;
}

/**
 * Take every process an earlier pass put in Darwin background back out, and forget them. Only a recorded pid that is
 * still a workspace's process is touched, since a stale report can name a pid the OS has given to something else.
 */
function release(deps: ApplyDeps): PriorityReport | undefined {
  const procs = deps.procs();

  if (!procs) {
    return undefined;
  }

  const previous = deps.previous().workspaces;
  const owners = workspaceOf(procs, protectedPids(procs, deps.extraProtected()), deps.root);
  const owned = deps.policy === BackgroundPolicy.Darwin ? Object.entries(previous).flatMap(([ws, w]) => w.backgroundPids.filter((pid) => owners.get(pid) === ws)) : [];
  const failed = new Set(owned.filter((pid) => !deps.run(["taskpolicy", "-B", "-p", String(pid)])));
  const report = settleReport({ ...emptyReport(), at: deps.now() }, previous, new Set(), failed);
  deps.write(report);

  return report;
}

/**
 * One pass: renice and move each workspace's processes to its class, and record what was done. Undefined when the
 * process list could not be read, so the last report (and its background pids) stays.
 */
export function applyPriority(deps: ApplyDeps): PriorityReport | undefined {
  if (!deps.enabled()) {
    return release(deps);
  }

  const procs = deps.procs();

  if (!procs) {
    return undefined;
  }

  const priorityClasses = deps.priorityClasses();
  const targets = Object.fromEntries(Object.entries(deps.classes()).map(([ws, name]) => [ws, classTarget(priorityClasses, name)]));

  const previous = deps.previous().workspaces;

  const plan = planPriority({
    procs,
    root: deps.root,
    extraProtected: deps.extraProtected(),
    targets,
    classNices: classTargets(priorityClasses).map((t) => t.nice),
    previous,
    policy: deps.policy,
    now: deps.now(),
  });

  // a process that exits mid-pass makes these fail for that pid only; the next pass sees the rest
  plan.renice.forEach(({ nice, pids }) => deps.run(["renice", String(nice), "-p", ...pids.flatMap(deps.threads).map(String)]));
  const failedBackground = new Set(plan.toBackground.filter((pid) => !deps.run(["taskpolicy", "-b", "-p", String(pid)])));
  const failedForeground = new Set(plan.toForeground.filter((pid) => !deps.run(["taskpolicy", "-B", "-p", String(pid)])));
  const report = settleReport(plan.report, previous, failedBackground, failedForeground);
  deps.write(report);

  return report;
}

/** A lock older than this is from a pass that died; a pass takes a few seconds at most. */
const LOCK_STALE_MS = 60_000;

/**
 * `fn` under a lock shared by every process that runs a pass (the server, a sidebar, `overbridge priority apply`),
 * so two passes never read the same report and overwrite each other's background pids. Undefined when another
 * pass holds it.
 */
export function withPassLock<T>(fn: () => T, lockFile = priorityLockPath()): T | undefined {
  mkdirSync(dirname(lockFile), { recursive: true });

  try {
    if (Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS) {
      rmSync(lockFile, { force: true });
    }
  } catch {
    // no lock file: nothing is running
  }

  let fd: number;

  try {
    fd = openSync(lockFile, "wx");
  } catch {
    return undefined;
  }

  try {
    return fn();
  } finally {
    closeSync(fd);
    rmSync(lockFile, { force: true });
  }
}

/**
 * Each workspace that is neither iceboxed nor being removed, with its class. One whose class is not known yet gets no
 * target: a guessed class could renice it past what a later pass can undo.
 */
export function liveClassesFrom(workspaces: State["workspaces"], classOf: (ws: string) => string | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(workspaces).flatMap(([ws, w]) => {
      const name = isIceboxed(w) || (w.removing && isRemoving(w)) ? undefined : classOf(ws);

      return name ? [[ws, name] as const] : [];
    }),
  );
}

const liveClasses = () => liveClassesFrom(readState().workspaces, (ws) => readTopCache(ws).priority);

function serverPid(): number[] {
  const pid = readServerPid();

  return pid !== undefined && pid > 1 && pidAlive(pid) ? [pid] : [];
}

export const defaultApplyDeps = (): ApplyDeps => ({
  enabled: () => loadRootLayers().cpuPriority,
  procs: () => listEnvProcs(WORKSPACE_ENV, ROOT_ENV),
  root: root(),
  classes: liveClasses,
  priorityClasses: () => loadRootLayers().checkClasses,
  extraProtected: serverPid,
  threads: threadIds,
  previous: () => readPriorityReport(),
  run: (cmd) => Bun.spawnSync({ cmd, cwd: spawnCwd(), stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exitCode === 0,
  write: (report) => writePriorityReport(report),
  policy: backgroundPolicy(),
  now: Date.now,
});

/** `overbridge priority`: the last pass's report as a table, or JSON. */
export function formatReport(report: PriorityReport): string {
  const rows = Object.entries(report.workspaces).toSorted(([a], [b]) => a.localeCompare(b));

  if (!rows.length) {
    return "no pass has run yet (overbridge priority apply runs one)";
  }

  const header = ["workspace", "class", "nice", "background", "procs", "stuck"];
  const body = rows.map(([ws, w]) => [ws, w.class, String(w.nice), w.background ? "yes" : "no", String(w.procs), w.stuck ? `${w.stuck} (restart to raise)` : "0"]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();

  return [line(header), ...body.map(line)].join("\n");
}

export function priorityCommand(args: readonly string[]): void {
  const [action, ...rest] = args;
  const json = rest.includes("--json") || action === "--json";

  if (action === "apply") {
    const report = withPassLock(() => applyPriority(defaultApplyDeps()) ?? Error("could not list processes (ps failed or timed out)"));

    if (!report) {
      // the pass already running does this one's work, so skipping is not a failure
      console.log(`another pass is running (${priorityLockPath()}); skipped`);

      return;
    }

    if (report instanceof Error) {
      throw new Error(`overbridge priority apply: ${report.message}; nothing was changed`);
    }

    console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));

    return;
  }

  if (action !== undefined && action !== "--json") {
    throw new Error(`overbridge priority: unknown action "${action}" (usage: overbridge priority [apply] [--json])`);
  }

  const report = readPriorityReport();
  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
}

/** Run a pass in a detached child, so its `ps` and renice calls never hold up the caller. Resolves to its exit code; a failed spawn rejects. */
export async function startPriorityPass(): Promise<number> {
  const proc = Bun.spawn({ cmd: [...selfCommand(), "priority", "apply"], cwd: spawnCwd(), stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });

  return proc.exited;
}
