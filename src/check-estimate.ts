import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ticket } from "./check-queue";
import { commandGroup, redactCommand } from "./history";
import { isRecord } from "./util";

/**
 * How long a check usually runs, and when each queued check should start and finish. Run times come from
 * `<meta>/check-estimates.json`: the last `KEPT_RUNS` run times per repo and command, and per repo and command
 * group, appended as each run ends. Reading it is one small file, so the sidebar, the @checks tab and `overbridge check`
 * all use it.
 */

/** Recent run times (ms, oldest first) per key from `estimateKeys`. */
export type EstimateStore = Readonly<Record<string, readonly number[]>>;

/** Run times kept per key: enough for a stable median, few enough to follow a repo that got faster. */
export const KEPT_RUNS = 20;

/** A run's usual length: the median of `runs` past runs. */
export interface Estimate {
  runMs: number;
  runs: number;
}

/** The store under `dir` (`<meta>`): beside the queue folder, which holds only tickets. */
export const estimatesFile = (dir: string) => join(dir, "check-estimates.json");

/** The exact command first, then its group, so `just test a.ts` falls back to how long `just test` runs take. */
export const estimateKeys = (repo: string, command: string): [exact: string, group: string] => [
  `cmd ${repo} ${redactCommand(command)}`,
  `group ${repo} ${commandGroup(command)}`,
];

const median = (values: readonly number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

/** `store` with `runMs` appended under both of the run's keys. */
export function withRun(store: EstimateStore, repo: string, command: string, runMs: number): EstimateStore {
  return Object.fromEntries([
    ...Object.entries(store),
    ...estimateKeys(repo, command).map((key) => [key, [...(store[key] ?? []), runMs].slice(-KEPT_RUNS)] as const),
  ]);
}

/** The usual run time of `command` in `repo`, or undefined with no past run of it or its group. */
export function estimateFor(store: EstimateStore, repo: string, command: string): Estimate | undefined {
  const runs = estimateKeys(repo, command)
    .map((key) => store[key] ?? [])
    .find((r) => r.length > 0);

  return runs ? { runMs: median(runs), runs: runs.length } : undefined;
}

/** The usual run time of exactly `command` in `repo`, from its own runs only; undefined before its first. */
export function exactEstimateFor(store: EstimateStore, repo: string, command: string): Estimate | undefined {
  const runs = store[estimateKeys(repo, command)[0]] ?? [];

  return runs.length ? { runMs: median(runs), runs: runs.length } : undefined;
}

const isRuns = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => Number.isFinite(n) && n >= 0);

/** The store in `dir`; empty when it is missing or unreadable, since estimates are only a hint. */
export function readEstimates(dir: string): EstimateStore {
  try {
    const parsed: unknown = JSON.parse(readFileSync(estimatesFile(dir), "utf8"));

    return isRecord(parsed) ? Object.fromEntries(Object.entries(parsed).filter((e): e is [string, number[]] => isRuns(e[1]))) : {};
  } catch {
    return {};
  }
}

/** Add a finished run. Two runs ending together can drop one sample, which an estimate can live with. Never throws. */
export function recordRunTime(dir: string, repo: string, command: string, runMs: number) {
  try {
    const tmp = `${estimatesFile(dir)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(withRun(readEstimates(dir), repo, command, runMs)) + "\n");
    renameSync(tmp, estimatesFile(dir));
  } catch {
    // estimates are best effort
  }
}

/** When a check should start and finish, as ms from now; `runMs` is undefined when nothing like it has run before. */
export interface Eta {
  startMs: number;
  doneMs: number;
  runMs?: number;
}

/**
 * The ETA of every live ticket, keyed by `ticketName` (`nameOf`), from a queue in queue order. Runs share
 * `slots` lanes: a waiting check starts when the first lane frees up. A check with no estimate counts as `fallbackMs`.
 */
export function queueEtas(
  queue: { running: readonly Ticket[]; waiting: readonly Ticket[] },
  store: EstimateStore,
  slots: number,
  now: number,
  nameOf: (t: Ticket) => string,
  fallbackMs: number,
): Map<string, Eta> {
  const runOf = (t: Ticket) => estimateFor(store, t.repo, t.command)?.runMs;

  const running = queue.running.map((t): [string, Eta] => {
    const runMs = runOf(t);
    const elapsedMs = now - (t.runningSinceMs ?? now);

    return [nameOf(t), { startMs: 0, doneMs: Math.max(0, (runMs ?? fallbackMs) - elapsedMs), runMs }];
  });

  const lanes = [...running.map(([, eta]) => eta.doneMs), ...Array.from({ length: Math.max(0, slots - running.length) }, () => 0)].toSorted((a, b) => a - b);

  const waiting = queue.waiting.reduce<{ etas: [string, Eta][]; lanes: number[] }>(
    (acc, t) => {
      const [startMs = 0, ...rest] = acc.lanes;
      const runMs = runOf(t);
      const doneMs = startMs + (runMs ?? fallbackMs);

      return { etas: [...acc.etas, [nameOf(t), { startMs, doneMs, runMs }]], lanes: [...rest, doneMs].toSorted((a, b) => a - b) };
    },
    { etas: [], lanes },
  );

  return new Map([...running, ...waiting.etas]);
}

/** How many checks run at once in the estimate: what runs now, at least one, at most `maxParallel`. */
export const etaSlots = (runningCount: number, maxParallel?: number) => Math.min(maxParallel ?? Number.POSITIVE_INFINITY, Math.max(1, runningCount));

/** The median of every kept run, for checks nothing has estimated yet. */
export function overallMs(store: EstimateStore): number {
  const all = Object.entries(store)
    .filter(([key]) => key.startsWith("group "))
    .flatMap(([, runs]) => runs);

  return all.length ? median(all) : DEFAULT_RUN_MS;
}

/** The guess for a run when no check has finished yet. */
const DEFAULT_RUN_MS = 60_000;

/** When each workspace's queued checks should all be done, as ms from now. */
export const workspaceDone = (queue: { running: readonly Ticket[]; waiting: readonly Ticket[] }, etas: ReadonlyMap<string, Eta>, nameOf: (t: Ticket) => string): Map<string, number> =>
  [...queue.running, ...queue.waiting].reduce((acc, t) => acc.set(t.ws, Math.max(acc.get(t.ws) ?? 0, etas.get(nameOf(t))?.doneMs ?? 0)), new Map<string, number>());

/** Seed a missing store from past check runs, oldest first, so estimates work before the next run ends. */
export function seedEstimates(dir: string, runs: readonly { repo: string; command: string; runMs: number }[]) {
  try {
    readFileSync(estimatesFile(dir));

    return;
  } catch {
    // no store yet: build one
  }

  const store = runs.reduce<EstimateStore>((acc, r) => withRun(acc, r.repo, r.command, r.runMs), {});

  try {
    const tmp = `${estimatesFile(dir)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(store) + "\n");
    renameSync(tmp, estimatesFile(dir));
  } catch {
    // estimates are best effort
  }
}

/** A duration as `42s`, `3m05s` or `2h07m`. */
export const formatDuration = (ms: number) => {
  const secs = Math.max(0, Math.round(ms / 1000));

  if (secs < 60) {
    return `${secs}s`;
  }

  const mins = Math.floor(secs / 60);

  return mins < 60 ? `${mins}m${String(secs % 60).padStart(2, "0")}s` : `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
};
