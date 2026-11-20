import { classTarget, classTargets, defaultClassName, type PriorityClass } from "./check-priority";
import { backgroundPolicy, type BackgroundPolicy, planPriority, type PriorityReport, readPriorityReport, WORKSPACE_ENV, writePriorityReport } from "./cpu-priority";
import { selfCommand } from "./paths";
import { type EnvProc, listEnvProcs, pidAlive } from "./proc";
import { loadRootLayers } from "./project-config";
import { pidFile } from "./server-net";
import { isIceboxed, isRemoving, readState } from "./state";
import { readTopCache } from "./top";
import { spawnCwd } from "./util";
import { readFileSync } from "node:fs";

/** How often the server runs a pass. */
export const PRIORITY_PASS_MS = 20_000;

export interface ApplyDeps {
  procs: () => EnvProc[];
  /** Each live workspace's class name, as its top cache last recorded it. */
  classes: () => Record<string, string>;
  priorityClasses: () => readonly PriorityClass[];
  /** Processes to leave alone besides the multiplexers: the server. */
  guarded: () => number[];
  previous: () => PriorityReport;
  run: (cmd: string[]) => void;
  write: (report: PriorityReport) => void;
  policy: BackgroundPolicy;
  now: () => number;
}

/** One pass: renice and move each workspace's processes to its class, and record what was done. */
export function applyPriority(deps: ApplyDeps): PriorityReport {
  const priorityClasses = deps.priorityClasses();
  const targets = Object.fromEntries(Object.entries(deps.classes()).map(([ws, name]) => [ws, classTarget(priorityClasses, name)]));

  const plan = planPriority({
    procs: deps.procs(),
    guarded: deps.guarded(),
    targets,
    classNices: classTargets(priorityClasses).map((t) => t.nice),
    previous: deps.previous().workspaces,
    policy: deps.policy,
    now: deps.now(),
  });

  // a process that exits mid-pass makes these fail for that pid only; the next pass sees the rest
  plan.renice.forEach(({ nice, pids }) => deps.run(["renice", String(nice), "-p", ...pids.map(String)]));
  plan.toBackground.forEach((pid) => deps.run(["taskpolicy", "-b", "-p", String(pid)]));
  plan.toForeground.forEach((pid) => deps.run(["taskpolicy", "-B", "-p", String(pid)]));
  deps.write(plan.report);

  return plan.report;
}

function liveClasses(): Record<string, string> {
  const classes = loadRootLayers().checkClasses;
  const fallback = defaultClassName(classes);

  return Object.fromEntries(
    Object.entries(readState().workspaces)
      .filter(([, w]) => !isIceboxed(w) && !(w.removing && isRemoving(w)))
      .map(([ws]) => [ws, readTopCache(ws).priority ?? fallback]),
  );
}

function serverPid(): number[] {
  try {
    const pid = Number(readFileSync(pidFile(), "utf8").trim());

    return Number.isInteger(pid) && pid > 1 && pidAlive(pid) ? [pid] : [];
  } catch {
    return [];
  }
}

export const defaultApplyDeps = (): ApplyDeps => ({
  procs: () => listEnvProcs(WORKSPACE_ENV),
  classes: liveClasses,
  priorityClasses: () => loadRootLayers().checkClasses,
  guarded: serverPid,
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
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();

  return [line(header), ...body.map(line)].join("\n");
}

export function priorityCommand(args: readonly string[]): void {
  const [action, ...rest] = args;
  const json = rest.includes("--json") || action === "--json";

  if (action === "apply") {
    const report = applyPriority(defaultApplyDeps());
    console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));

    return;
  }

  if (action !== undefined && action !== "--json") {
    throw new Error(`overbridge priority: unknown action "${action}" (usage: overbridge priority [apply] [--json])`);
  }

  const report = readPriorityReport();
  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
}

/** Run a pass in a detached child, so its `ps` and renice calls never hold up the caller. */
export function startPriorityPass(): Promise<number> {
  const proc = Bun.spawn({ cmd: [...selfCommand(), "priority", "apply"], cwd: spawnCwd(), stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });

  return proc.exited;
}
