import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  byQueueOrder,
  CheckExit,
  exitFor,
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

  test("dead owners leave the live queue; the first live ticket holds the turn", () => {
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

describe("queueView", () => {
  test("empty", () => {
    expect(queueView([])).toEqual({ waiting: [] });
  });

  test("a head that has started is running; the rest wait", () => {
    const head = ticket(1, 1, { runPid: 11, runningSinceMs: 5 });
    expect(queueView([head, ticket(2, 2)])).toEqual({ running: head, waiting: [ticket(2, 2)] });
  });

  test("a head still waiting for the load counts as waiting", () => {
    expect(queueView([ticket(1, 1), ticket(2, 2)])).toEqual({ waiting: [ticket(1, 1), ticket(2, 2)] });
  });
});
