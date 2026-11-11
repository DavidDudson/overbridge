import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  byQueueOrder,
  CheckExit,
  exitFor,
  Gate,
  gateFor,
  isStalled,
  loadAllows,
  nextSample,
  queueView,
  readTickets,
  sampleIntervalMs,
  splitQueue,
  StopReason,
  type Ticket,
  ticketName,
  unsettledLoad,
} from "../src/check-queue";

const ticket = (pid: number, queuedAtMs: number, extra: Partial<Ticket> = {}): Ticket => ({
  pid,
  ws: `w${pid}`,
  repo: "app",
  command: "just test",
  queuedAtMs,
  ...extra,
});

describe("queue order", () => {
  test("ticket names sort the way the queue runs: by time, then pid", () => {
    const tickets = [ticket(9, 1_000), ticket(10, 999), ticket(2, 1_000), ticket(1, 99_999)];
    const byName = tickets.toSorted((a, b) => ticketName(a).localeCompare(ticketName(b)));
    expect(byName).toEqual(tickets.toSorted(byQueueOrder));
    expect(byName.map((t) => t.pid)).toEqual([10, 2, 9, 1]);
  });

  test("dead owners leave the live queue; the rest keep their order", () => {
    const tickets = [ticket(1, 1), ticket(2, 2), ticket(3, 3)];
    const { live, dead } = splitQueue(tickets, (pid) => pid !== 1);
    expect(live.map((t) => t.pid)).toEqual([2, 3]);
    expect(dead.map((t) => t.pid)).toEqual([1]);
  });
});

describe("readTickets", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "overbridge-queue-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("reads tickets in queue order and skips torn, foreign and temp files", () => {
    const late = ticket(5, 2_000);
    const early = ticket(7, 1_000, { runPid: 70, runningSinceMs: 1_500 });
    writeFileSync(join(dir, ticketName(late)), JSON.stringify(late));
    writeFileSync(join(dir, ticketName(early)), JSON.stringify(early));
    writeFileSync(join(dir, "torn.json"), '{"pid": 3, "queuedAt');
    writeFileSync(join(dir, "foreign.json"), '{"hello": "there"}');
    writeFileSync(join(dir, `${ticketName(late)}.123.tmp`), JSON.stringify(ticket(4, 1)));
    expect(readTickets(dir)).toEqual([early, late]);
  });

  test("a missing directory is an empty queue", () => {
    expect(readTickets(join(dir, "nope"))).toEqual([]);
  });
});

describe("load gate", () => {
  test("starts only while the load is under the share of the cores", () => {
    expect(loadAllows(5.5, 8, 70)).toBe(true);
    expect(loadAllows(5.6, 8, 70)).toBe(false);
    expect(loadAllows(9, 8, 70)).toBe(false);
    expect(loadAllows(0, 1, 1)).toBe(true);
  });
});

describe("stall tracking", () => {
  test("the sample keeps its start while CPU time stands still and resets when it moves", () => {
    const first = nextSample(undefined, 1.5, 1_000);
    expect(first).toEqual({ cpuSeconds: 1.5, sinceMs: 1_000 });
    const still = nextSample(first, 1.5, 9_000);
    expect(still).toBe(first);
    expect(isStalled(still, 9_000, 8)).toBe(true);
    expect(isStalled(still, 8_999, 8)).toBe(false);
    expect(nextSample(still, 1.6, 10_000)).toEqual({ cpuSeconds: 1.6, sinceMs: 10_000 });
  });

  test("samples a quarter of the stall period apart, at most every 15 s", () => {
    expect(sampleIntervalMs(2)).toBe(500);
    expect(sampleIntervalMs(300)).toBe(15_000);
  });

  test("each stop reason has its own exit code", () => {
    expect(exitFor(StopReason.TimedOut)).toBe(CheckExit.TimedOut);
    expect(exitFor(StopReason.Stalled)).toBe(CheckExit.Stalled);
  });
});

describe("start gate", () => {
  const settings = { maxLoadPercent: 70, timeoutSeconds: 180, stallSeconds: 300, waitSeconds: 900 };
  const idle = { load1: 0, cores: 8 };
  const NOW_MS = 10_000_000;
  /** Started long enough ago that the load average shows it. */
  const settled = (pid: number) => ticket(pid, pid, { runPid: pid * 10, runningSinceMs: 0 });
  const me = ticket(5, 5);

  test("an empty queue starts while the load allows", () => {
    expect(gateFor(me, [me], settings, idle, NOW_MS)).toBe(Gate.Start);
    expect(gateFor(me, [me], settings, { load1: 5.6, cores: 8 }, NOW_MS)).toBe(Gate.Load);
  });

  test("starts beside running tickets, and ignores the tickets behind it", () => {
    expect(gateFor(me, [settled(1), settled(2), me, ticket(6, 6)], settings, idle, NOW_MS)).toBe(Gate.Start);
  });

  test("keeps queue order: waits while a ticket ahead has not started", () => {
    expect(gateFor(me, [settled(1), ticket(2, 2), me], settings, idle, NOW_MS)).toBe(Gate.Queue);
  });

  test("max-parallel caps the runs; 1 is one at a time", () => {
    const live = [settled(1), settled(2), me];
    expect(gateFor(me, live, { ...settings, maxParallel: 2 }, idle, NOW_MS)).toBe(Gate.Parallel);
    expect(gateFor(me, live, { ...settings, maxParallel: 3 }, idle, NOW_MS)).toBe(Gate.Start);
    expect(gateFor(me, [settled(1), me], { ...settings, maxParallel: 1 }, idle, NOW_MS)).toBe(Gate.Parallel);
  });

  test("a run that just started counts as a core the load average does not show yet", () => {
    const fresh = ticket(1, 1, { runPid: 10, runningSinceMs: NOW_MS });
    expect(unsettledLoad([fresh], NOW_MS)).toBe(1);
    expect(unsettledLoad([fresh], NOW_MS + 60_000)).toBeCloseTo(Math.exp(-1));
    expect(unsettledLoad([settled(1)], NOW_MS)).toBeLessThan(0.001);
    const nearLimit = { load1: 5, cores: 8 };
    expect(gateFor(me, [fresh, me], settings, nearLimit, NOW_MS)).toBe(Gate.Load);
    expect(gateFor(me, [settled(1), me], settings, nearLimit, NOW_MS)).toBe(Gate.Start);
  });
});

describe("queueView", () => {
  test("empty", () => {
    expect(queueView([])).toEqual({ running: [], waiting: [] });
  });

  test("every started ticket is running; the rest wait", () => {
    const first = ticket(1, 1, { runPid: 11, runningSinceMs: 5 });
    const second = ticket(2, 2, { runPid: 22, runningSinceMs: 6 });
    expect(queueView([first, second, ticket(3, 3)])).toEqual({ running: [first, second], waiting: [ticket(3, 3)] });
  });

  test("a head still waiting for the load counts as waiting", () => {
    expect(queueView([ticket(1, 1), ticket(2, 2)])).toEqual({ running: [], waiting: [ticket(1, 1), ticket(2, 2)] });
  });
});
