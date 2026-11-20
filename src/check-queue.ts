import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, constants, loadavg } from "node:os";
import { join } from "node:path";
import { defaultKey, type QueueOverrides, readOverrides } from "./check-priority";
import { classifyCommand, commandGroup, commandLabel, redactCommand, type HistoryStore, historyStore } from "./history";
import { metaDir } from "./paths";
import { groupAlive, groupCpuSeconds, pidsAlive } from "./proc";
import type { CheckQueue } from "./project-config";
import type { ShellInvocation } from "./shell";
import { exec, isNumber, isRecord, type Json, log } from "./util";

/**
 * `overbridge check`: heavy commands from every workspace, started in queue order while the load leaves room.
 * Each caller drops a ticket in `<meta>/check-queue/`; tickets queue by `queueComparator`. A ticket starts once every
 * live ticket ahead of it is running, fewer than `max-parallel` live tickets are, and the load allows. Only a ticket's owner writes it, and
 * only the first waiting ticket may start, so the queue needs no lock. Each run has its own process group,
 * which its owner kills on a timeout or a stall.
 */

/** Set in the command's env; a nested `overbridge check` sees it and runs at once instead of queueing behind itself. */
export const HELD_ENV = "OVERBRIDGE_CHECK_HELD";

export const CheckExit = {
  /** No turn, or the load stayed high, within `wait-seconds`. */
  GaveUp: 75,
  TimedOut: 124,
  Stalled: 137,
} as const;

export type CheckExit = (typeof CheckExit)[keyof typeof CheckExit];

export const StopReason = { TimedOut: "timed-out", Stalled: "stalled" } as const;

export type StopReason = (typeof StopReason)[keyof typeof StopReason];

export interface Ticket {
  /** The `overbridge check` process that owns the ticket. */
  pid: number;
  ws: string;
  repo: string;
  command: string;
  queuedAtMs: number;
  /** The workspace's class when it was queued (see `ClassInfo`); a ticket with no `rank` comes from an older overbridge. */
  priority?: string;
  rank?: number;
  icon?: string;
  /** Group leader of the running command, once it has the turn. */
  runPid?: number;
  runningSinceMs?: number;
}

/** What the watchdog of a running command has seen: why it stopped it, and the last CPU sample. */
interface RunWatch {
  stopped?: StopReason;
  sample?: CpuSample;
  sampledMs: number;
}

/** The group leader of the command this process is running, so a signal can reach it. */
interface HeldRun {
  runPid?: number;
  startedMs?: number;
}

const TURN_POLL_MS = 1_000;

/** How long the 1-minute load average takes to show most of a new run. */
const LOAD_SETTLE_MS = 60_000;
const MAX_SAMPLE_MS = 15_000;
const KILL_GRACE_MS = 10_000;

export const queueDir = () => join(metaDir(), "check-queue");

/** Zero-padded so the file names sort in queue order. */
export const ticketName = (t: Pick<Ticket, "queuedAtMs" | "pid">) => `${String(t.queuedAtMs).padStart(15, "0")}-${t.pid}.json`;

export type TicketComparator = (a: Ticket, b: Ticket) => number;

/** Queue order by time alone, as an older overbridge sorts. */
export const byQueueOrder: TicketComparator = (a, b) => a.queuedAtMs - b.queuedAtMs || a.pid - b.pid;

/** A ticket's place in the queue: the @checks tab's override, else its class rank and when it was queued. */
export const ticketKey = (t: Ticket, overrides: QueueOverrides = {}) => overrides[ticketName(t)] ?? defaultKey(t.rank ?? 0, t.queuedAtMs);

/** Queue order by class, then time, under the @checks tab's overrides. */
export const queueComparator =
  (overrides: QueueOverrides = {}): TicketComparator =>
  (a, b) =>
    ticketKey(a, overrides) - ticketKey(b, overrides) || byQueueOrder(a, b);

/**
 * The comparator every process agrees on for `tickets`. An older overbridge sorts by time only, so while one of its
 * tickets (no `rank`) is queued, every process sorts by time; two orders at once would leave each waiting on the other.
 */
export const comparatorFor = (tickets: readonly Ticket[], overrides: QueueOverrides): TicketComparator =>
  tickets.some((t) => t.rank === undefined) ? byQueueOrder : queueComparator(overrides);

/** The live tickets that sort ahead of `me`. */
export const aheadOf = (me: Ticket, live: readonly Ticket[], cmp: TicketComparator): Ticket[] => live.filter((t) => cmp(t, me) < 0);

const isRank = (v: Json | undefined) => v === undefined || (Number.isInteger(v) && isNumber(v) && v >= 0);

const isTicket = (v: unknown): v is Ticket => isRecord(v) && Number.isInteger(v.pid) && Number.isFinite(v.queuedAtMs) && isRank(v.rank);

/** Every readable ticket, in queue order. A torn or foreign file is skipped. */
export function readTickets(dir = queueDir(), overrides: QueueOverrides = readOverrides(dir)): Ticket[] {
  const names = (() => {
    try {
      return readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
  })();

  const tickets = names
    .flatMap((name) => {
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));

        return isTicket(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });

  return tickets.toSorted(comparatorFor(tickets, overrides));
}

export interface SplitQueue {
  live: Ticket[];
  dead: Ticket[];
}

/** Tickets whose owner is alive, in queue order, and the ones left by dead owners. */
export function splitQueue(tickets: Ticket[], alive: (pid: number) => boolean): SplitQueue {
  return { live: tickets.filter((t) => alive(t.pid)), dead: tickets.filter((t) => !alive(t.pid)) };
}

/** `splitQueue` with every owner looked up in one batch (`pidsAlive`). */
export function splitLive(tickets: Ticket[]): SplitQueue {
  const alive = pidsAlive(tickets.map((t) => t.pid));

  return splitQueue(tickets, (pid) => alive.has(pid));
}

/** Whether the 1-minute load leaves room to start: under `percent` of `cores`. */
export const loadAllows = (load1: number, cores: number, percent: number) => load1 < (cores * percent) / 100;

/** When the process group's CPU time last moved. */
export interface CpuSample {
  cpuSeconds: number;
  sinceMs: number;
}

/** Keep the previous sample while the CPU time stands still, so `sinceMs` marks when it stopped moving. */
export const nextSample = (prev: CpuSample | undefined, cpuSeconds: number, nowMs: number): CpuSample =>
  prev && prev.cpuSeconds === cpuSeconds ? prev : { cpuSeconds, sinceMs: nowMs };

export const isStalled = (sample: CpuSample, nowMs: number, stallSeconds: number) => nowMs - sample.sinceMs >= stallSeconds * 1_000;

/** How often the holder samples CPU: often enough to see a stall within a quarter of `stall-seconds`. */
export const sampleIntervalMs = (stallSeconds: number) => Math.min(MAX_SAMPLE_MS, stallSeconds * 250);

export const exitFor = (reason: StopReason): CheckExit => (reason === StopReason.TimedOut ? CheckExit.TimedOut : CheckExit.Stalled);

const isRunning = (t: Ticket) => t.runPid !== undefined;

/**
 * The load that runs started in the last minute add but the 1-minute average does not show yet. It counts
 * one core for a run that just started, less as the average catches up, so a burst of starts cannot slip
 * under the load gate together.
 */
export const unsettledLoad = (running: Ticket[], nowMs: number) =>
  running.reduce((sum, t) => sum + Math.exp(-Math.max(0, nowMs - (t.runningSinceMs ?? nowMs)) / LOAD_SETTLE_MS), 0);

export const Gate = {
  Start: "start",
  /** A ticket ahead has not started, so starting now would jump the queue. */
  Queue: "queue",
  /** `max-parallel` runs are already going. */
  Parallel: "parallel",
  Load: "load",
} as const;

export type Gate = (typeof Gate)[keyof typeof Gate];

export interface Machine {
  load1: number;
  cores: number;
}

/** Whether `me` may start now, given the live queue, or what holds it back. */
export function gateFor(me: Ticket, live: Ticket[], settings: CheckQueue, machine: Machine, nowMs: number, overrides: QueueOverrides = {}): Gate {
  if (!aheadOf(me, live, comparatorFor(live, overrides)).every(isRunning)) {
    return Gate.Queue;
  }

  // a higher class or a moved ticket can sort ahead of runs already going, so the caps count every run
  const running = live.filter(isRunning);

  if (settings.maxParallel !== undefined && running.length >= settings.maxParallel) {
    return Gate.Parallel;
  }

  // load from outside the queue (agents, panes, dev servers) can stay over the limit for hours; one run keeps it moving
  if (running.length === 0) {
    return Gate.Start;
  }

  return loadAllows(machine.load1 + unsettledLoad(running, nowMs), machine.cores, settings.maxLoadPercent) ? Gate.Start : Gate.Load;
}

export interface QueueView {
  running: Ticket[];
  waiting: Ticket[];
}

/** The running tickets and the ones waiting, each in queue order, for the sidebar. */
export function queueView(tickets: Ticket[]): QueueView {
  return { running: tickets.filter(isRunning), waiting: tickets.filter((t) => !isRunning(t)) };
}

/** The live queue as the sidebar and the @checks tab show it. */
export function readQueue(dir = queueDir(), overrides: QueueOverrides = readOverrides(dir)): QueueView {
  const { live } = splitLive(readTickets(dir, overrides));

  // sorted by the live tickets alone, as `gateFor` sorts, so a dead ticket left by an older build cannot change the order shown
  return queueView(live.toSorted(comparatorFor(live, overrides)));
}

function writeTicket(file: string, ticket: Ticket) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ticket) + "\n");
  renameSync(tmp, file);
}

const signalGroup = (pgid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pgid, signal);
  } catch {
    // the group is already gone
  }
};

/** TERM the group so it can clean up, then KILL whatever is left after the grace period. */
async function killGroup(pgid: number) {
  signalGroup(pgid, "SIGTERM");
  const deadline = Date.now() + KILL_GRACE_MS;

  while (groupAlive(pgid) && Date.now() < deadline) {
    await Bun.sleep(200);
  }

  signalGroup(pgid, "SIGKILL");
}

/** A dead owner's ticket: kill the command it left running, so the queue moves on, then drop the ticket. */
function reap(ticket: Ticket, dir: string) {
  if (ticket.runPid !== undefined && groupAlive(ticket.runPid)) {
    log(`overbridge check: the holder from ${ticket.ws} died; killing what it left running: ${ticket.command}`);
    signalGroup(ticket.runPid, "SIGKILL");
  }

  rmSync(join(dir, ticketName(ticket)), { force: true });
}

/**
 * Stop one check, queued or running: TERM the command's group, TERM the owning `overbridge check` (which records the
 * run as killed), and drop the ticket so the queue moves on.
 */
export function stopTicket(t: Ticket, dir = queueDir()) {
  if (t.runPid !== undefined && groupAlive(t.runPid)) {
    signalGroup(t.runPid, "SIGTERM");
  }

  try {
    process.kill(t.pid, "SIGTERM");
  } catch {
    // the owner is already gone
  }

  rmSync(join(dir, ticketName(t)), { force: true });
}

/** Stop every check `ws` has queued or running (see `stopTicket`). Returns how many tickets it stopped. */
export function stopChecksFor(ws: string, dir = queueDir()): number {
  const mine = readTickets(dir).filter((t) => t.ws === ws);
  mine.forEach((t) => stopTicket(t, dir));

  return mine.length;
}

/** Append the run to the workspace's history. Never throws: a check's exit code does not depend on it. */
export function recordCheck(me: Ticket, startedMs: number, endedMs: number | undefined, exit: number, store: HistoryStore = historyStore()) {
  try {
    store.append(me.ws, {
      kind: "check",
      at: endedMs ?? startedMs,
      repo: me.repo,
      command: commandLabel(me.command),
      full: redactCommand(me.command),
      group: commandGroup(me.command),
      cls: classifyCommand(me.command),
      queuedMs: startedMs - me.queuedAtMs,
      runMs: endedMs === undefined ? 0 : endedMs - startedMs,
      exit,
    });
  } catch {
    // history is best effort
  }
}

const label = (t: Ticket) => `${t.ws}/${t.repo}: ${t.command}`;

/** Wait until `me` may start (see `gateFor`); false when `deadlineMs` passes first. */
async function waitForStart(me: Ticket, dir: string, settings: CheckQueue, deadlineMs: number): Promise<boolean> {
  const cores = availableParallelism();
  const limit = (cores * settings.maxLoadPercent) / 100;
  let announced: string | undefined;

  for (;;) {
    const overrides = readOverrides(dir);
    const { live, dead } = splitLive(readTickets(dir, overrides));
    dead.forEach((t) => reap(t, dir));
    const now = Date.now();
    const ahead = aheadOf(me, live, comparatorFor(live, overrides));
    const load1 = loadavg()[0] ?? 0;
    const gate = gateFor(me, live, settings, { load1, cores }, now, overrides);

    if (gate === Gate.Start) {
      return true;
    }

    const running = live.filter(isRunning);
    const runningNow = running.length ? `running: ${running.map(label).join("; ")}` : "nothing running yet";
    const overLoad = `load ${(load1 + unsettledLoad(running, now)).toFixed(2)} is over ${limit.toFixed(1)} (${settings.maxLoadPercent}% of ${cores} cores)`;

    if (now >= deadlineMs) {
      log(
        gate === Gate.Load
          ? `overbridge check: ${overLoad} for ${settings.waitSeconds}s (wait-seconds); giving up`
          : `overbridge check: the queue was still busy after ${settings.waitSeconds}s (wait-seconds); ${runningNow}`,
      );

      return false;
    }

    const key = `${gate} ${ahead.map(ticketName).join(" ")}`;

    if (announced !== key) {
      announced = key;
      const cap = gate === Gate.Parallel ? ` (max-parallel ${settings.maxParallel})` : "";
      log(gate === Gate.Load ? `overbridge check: ${overLoad}, waiting; ${runningNow}` : `overbridge check: waiting behind ${ahead.length} in the queue${cap}; ${runningNow}`);
    }

    await Bun.sleep(Math.min(TURN_POLL_MS, Math.max(0, deadlineMs - now)));
  }
}

const signalExitOf = (signal: NodeJS.Signals | number) => (isNumber(signal) ? 128 + signal : signalExit(signal));

const signalExit = (signal: NodeJS.Signals) => 128 + (constants.signals[signal] ?? 0);

/** Run the command in its own process group and watch it until it exits, times out or stalls. */
async function runHeld(inv: ShellInvocation, me: Ticket, file: string, settings: CheckQueue, onStart: (pid: number) => void): Promise<number> {
  const child = Bun.spawn({
    cmd: inv.cmd,
    cwd: inv.cwd,
    env: { ...process.env, ...inv.env, [HELD_ENV]: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    detached: true,
  });

  onStart(child.pid);
  const startedMs = Date.now();
  writeTicket(file, { ...me, runPid: child.pid, runningSinceMs: startedMs });

  const watch: RunWatch = { sampledMs: startedMs };

  const stop = (reason: StopReason, message: string) => {
    if (watch.stopped) {
      return;
    }

    watch.stopped = reason;
    log(`overbridge check: ${message}: ${me.command}`);
    void killGroup(child.pid);
  };

  const sampleMs = sampleIntervalMs(settings.stallSeconds);

  const timer = setInterval(() => {
    const now = Date.now();

    if (now - startedMs >= settings.timeoutSeconds * 1_000) {
      stop(StopReason.TimedOut, `stopped after ${settings.timeoutSeconds}s (timeout-seconds; pass --timeout-seconds for longer)`);

      return;
    }

    if (now - watch.sampledMs >= sampleMs) {
      watch.sampledMs = now;
      watch.sample = nextSample(watch.sample, groupCpuSeconds(child.pid), now);

      if (isStalled(watch.sample, now, settings.stallSeconds)) {
        stop(StopReason.Stalled, `killed: it used no CPU for ${settings.stallSeconds}s (stall-seconds)`);
      }
    }
  }, Math.min(1_000, sampleMs));

  const code = await child.exited;
  clearInterval(timer);

  if (watch.stopped) {
    return exitFor(watch.stopped);
  }

  return child.signalCode ? signalExitOf(child.signalCode) : code;
}

/**
 * Run `inv` when the queue and the load allow, and return its exit code: the command's own, or
 * `CheckExit.GaveUp`, `TimedOut` or `Stalled`. Inside a held run (`HELD_ENV` set) it runs at once.
 */
export async function runCheck(inv: ShellInvocation, who: Pick<Ticket, "ws" | "repo" | "command" | "priority" | "rank" | "icon">, settings: CheckQueue): Promise<number> {
  if (process.env[HELD_ENV]) {
    return exec(inv.cmd, { cwd: inv.cwd, env: inv.env });
  }

  const dir = queueDir();
  mkdirSync(dir, { recursive: true });
  const me: Ticket = { pid: process.pid, ...who, queuedAtMs: Date.now() };
  const file = join(dir, ticketName(me));
  writeTicket(file, me);

  const held: HeldRun = {};
  const leave = () => rmSync(file, { force: true });

  const onSignal = (signal: NodeJS.Signals) => {
    if (held.runPid !== undefined) {
      signalGroup(held.runPid, "SIGTERM");
    }

    const now = Date.now();
    recordCheck(me, held.startedMs ?? now, held.startedMs === undefined ? undefined : now, signalExit(signal));
    leave();
    process.exit(signalExit(signal));
  };

  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  signals.forEach((s) => process.on(s, onSignal));
  process.on("exit", leave);

  try {
    const deadlineMs = me.queuedAtMs + settings.waitSeconds * 1_000;

    if (!(await waitForStart(me, dir, settings, deadlineMs))) {
      recordCheck(me, Date.now(), undefined, CheckExit.GaveUp);

      return CheckExit.GaveUp;
    }

    const startedMs = Date.now();

    const code = await runHeld(inv, me, file, settings, (pid) => {
      held.runPid = pid;
      held.startedMs = startedMs;
    });

    recordCheck(me, startedMs, Date.now(), code);

    return code;
  } finally {
    signals.forEach((s) => process.off(s, onSignal));
    process.off("exit", leave);
    leave();
  }
}
