import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ticket } from "./check-queue";
import { type CheckRecord, REDACTED_MAX_CHARS, redactCommand } from "./history";
import { isRecord } from "./util";

/**
 * How long a check usually runs, and when each queued check should start and finish. Run times come from
 * `<meta>/check-estimates.json`: the last `KEPT_RUNS` run times per repo and exact command, appended as each run ends.
 * Only that exact command's runs count, since a similar command can take far longer or shorter. Reading it is one
 * small file, so the sidebar, the @checks tab and `overbridge check` all use it.
 */

/** Recent run times (ms, oldest first) per key from `estimateKey`. */
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

const KEY_PREFIX = "cmd ";

/** The store key of a repo's exact command; redacted so the file never holds a secret the command carried. */
export const estimateKey = (repo: string, command: string) => `${KEY_PREFIX}${repo} ${redactCommand(command)}`;

const median = (values: readonly number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

/** `store` with `runMs` appended under the run's key. */
export function withRun(store: EstimateStore, repo: string, command: string, runMs: number): EstimateStore {
  const key = estimateKey(repo, command);

  return Object.fromEntries([...Object.entries(store), [key, [...(store[key] ?? []), runMs].slice(-KEPT_RUNS)] as const]);
}

/**
 * The usual run time of exactly `command` in `repo`; undefined before its first run, and for a command too long for
 * its key to tell it from another that starts the same way.
 */
export function estimateFor(store: EstimateStore, repo: string, command: string): Estimate | undefined {
  if (redactCommand(command).length >= REDACTED_MAX_CHARS) {
    return undefined;
  }

  const runs = store[estimateKey(repo, command)] ?? [];

  return runs.length ? { runMs: median(runs), runs: runs.length } : undefined;
}

const isRuns = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => Number.isFinite(n) && n >= 0);

/** The store in `dir`; empty when it is missing or unreadable, since estimates are only a hint. Keys this build never reads are kept for older builds. */
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

/** When a check should start and finish, as ms from now; each field is undefined when it cannot be known (see `queueEtas`). */
export interface Eta {
  startMs?: number;
  doneMs?: number;
  runMs?: number;
}

/** When a lane frees up, as ms from now; undefined when a check on it has no estimate. */
type Lane = number | undefined;

const plus = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? undefined : a + b);

/** Known lanes first, earliest first, so the next check takes the lane that frees first. */
const sortLanes = (lanes: readonly Lane[]) => lanes.toSorted((a, b) => (a ?? Number.POSITIVE_INFINITY) - (b ?? Number.POSITIVE_INFINITY));

/**
 * The ETA of every live ticket, keyed by `ticketName` (`nameOf`), from a queue in queue order. Runs share `slots` lanes:
 * a waiting check starts when the first lane frees up. A check with no `runMs` has no `doneMs`, and while it holds a lane
 * no later check gets a `startMs`, since that lane could free at any time.
 */
export function queueEtas(
  queue: { running: readonly Ticket[]; waiting: readonly Ticket[] },
  store: EstimateStore,
  slots: number,
  now: number,
  nameOf: (t: Ticket) => string,
): Map<string, Eta> {
  const runOf = (t: Ticket) => estimateFor(store, t.repo, t.command)?.runMs;

  const running = queue.running.map((t): [string, Eta] => {
    const runMs = runOf(t);
    const elapsedMs = now - (t.runningSinceMs ?? now);

    return [nameOf(t), { startMs: 0, doneMs: runMs === undefined ? undefined : Math.max(0, runMs - elapsedMs), runMs }];
  });

  const lanes = sortLanes([...running.map(([, eta]) => eta.doneMs), ...Array.from({ length: Math.max(0, slots - running.length) }, () => 0)]);

  const waiting = queue.waiting.reduce<{ etas: [string, Eta][]; lanes: Lane[] }>(
    (acc, t) => {
      const [first, ...rest] = acc.lanes;
      const startMs = acc.lanes.includes(undefined) ? undefined : (first ?? 0);
      const runMs = runOf(t);
      const doneMs = plus(startMs, runMs);

      return { etas: [...acc.etas, [nameOf(t), { startMs, doneMs, runMs }]], lanes: sortLanes([...rest, doneMs]) };
    },
    { etas: [], lanes },
  );

  return new Map([...running, ...waiting.etas]);
}

/** How many checks run at once in the estimate: what runs now, at least one, at most `maxParallel`. */
export const etaSlots = (runningCount: number, maxParallel?: number) => Math.min(maxParallel ?? Number.POSITIVE_INFINITY, Math.max(1, runningCount));

/** When the last of `doneMsList` finishes, or undefined when any of them is unknown. */
export const lastDoneMs = (doneMsList: readonly (number | undefined)[]) => (doneMsList.every((ms) => ms !== undefined) ? Math.max(0, ...doneMsList) : undefined);

/** When each workspace's queued checks should all be done, as ms from now; a workspace with any unknown `doneMs` is left out. */
export function workspaceDone(queue: { running: readonly Ticket[]; waiting: readonly Ticket[] }, etas: ReadonlyMap<string, Eta>, nameOf: (t: Ticket) => string): Map<string, number> {
  const byWs = [...queue.running, ...queue.waiting].reduce(
    (acc, t) => acc.set(t.ws, [...(acc.get(t.ws) ?? []), etas.get(nameOf(t))?.doneMs]),
    new Map<string, (number | undefined)[]>(),
  );

  return new Map(
    [...byWs].flatMap(([ws, doneMsList]) => {
      const doneMs = lastDoneMs(doneMsList);

      return doneMs === undefined ? [] : [[ws, doneMs] as const];
    }),
  );
}

/** `; estimated start in ~2m, run ~3m10s`, with each part only when it is known, or empty when neither is. */
export function etaSummary(eta: Eta | undefined): string {
  const parts = [
    ...(eta?.startMs === undefined ? [] : [`estimated start in ~${formatDuration(eta.startMs)}`]),
    ...(eta?.runMs === undefined ? [] : [`run ~${formatDuration(eta.runMs)}`]),
  ];

  return parts.length ? `; ${parts.join(", ")}` : "";
}

/** The runs to seed from `records` (newest first), oldest first: only finished, unkilled runs that recorded their full command. */
export const seedRuns = (records: readonly { record: CheckRecord }[]) =>
  records
    .flatMap(({ record }) => (record.runMs > 0 && !record.killed && record.full !== undefined ? [{ repo: record.repo, command: record.full, runMs: record.runMs }] : []))
    .toReversed();

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
