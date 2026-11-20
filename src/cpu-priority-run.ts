import { classTarget, classTargets, type PriorityClass } from "./check-priority";
import { backgroundPolicy, BackgroundPolicy, emptyReport, planPriority, type PriorityReport, protectedPids, readPriorityReport, WORKSPACE_ENV, workspaceOf, writePriorityReport } from "./cpu-priority";
import { selfCommand } from "./paths";
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
  /** Each live workspace's class name, as its top cache last recorded it; a workspace with none yet is left out. */
  classes: () => Record<string, string>;
  priorityClasses: () => readonly PriorityClass[];
  /** Processes to leave alone besides the multiplexers: the server. */
  extraProtected: () => number[];
  /** Every thread a renice of `pid` has to reach. */
  threads: (pid: number) => number[];
  previous: () => PriorityReport;
  run: (cmd: string[]) => void;
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

  if (deps.policy === BackgroundPolicy.Darwin) {
    const owners = workspaceOf(procs, protectedPids(procs, deps.extraProtected()));
    Object.entries(deps.previous().workspaces)
      .flatMap(([ws, w]) => w.backgroundPids.filter((pid) => owners.get(pid) === ws))
      .forEach((pid) => deps.run(["taskpolicy", "-B", "-p", String(pid)]));
  }

  const report = { ...emptyReport(), at: deps.now() };
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

  const plan = planPriority({
    procs,
    extraProtected: deps.extraProtected(),
    targets,
    classNices: classTargets(priorityClasses).map((t) => t.nice),
    previous: deps.previous().workspaces,
    policy: deps.policy,
    now: deps.now(),
  });

  // a process that exits mid-pass makes these fail for that pid only; the next pass sees the rest
  plan.renice.forEach(({ nice, pids }) => deps.run(["renice", String(nice), "-p", ...pids.flatMap(deps.threads).map(String)]));
  plan.toBackground.forEach((pid) => deps.run(["taskpolicy", "-b", "-p", String(pid)]));
  plan.toForeground.forEach((pid) => deps.run(["taskpolicy", "-B", "-p", String(pid)]));
  deps.write(plan.report);

  return plan.report;
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
  procs: () => listEnvProcs(WORKSPACE_ENV),
  classes: liveClasses,
  priorityClasses: () => loadRootLayers().checkClasses,
  extraProtected: serverPid,
  threads: threadIds,
  previous: () => readPriorityReport(),
  run: (cmd) => {
    Bun.spawnSync({ cmd, cwd: spawnCwd(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  },
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
    const report = applyPriority(defaultApplyDeps());

    if (!report) {
      throw new Error("overbridge priority apply: could not list processes (ps failed or timed out); nothing was changed");
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
