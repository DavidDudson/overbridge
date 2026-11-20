import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EstimateStore, estimateFor, estimateKeys, estimatesFile, etaSlots, formatDuration, KEPT_RUNS, overallMs, queueEtas, readEstimates, recordRunTime, seedEstimates, withRun, workspaceDone } from "../src/check-estimate";
import type { Ticket } from "../src/check-queue";

const NOW_MS = 1_000_000;

const ticket = (pid: number, extra: Partial<Ticket> = {}): Ticket => ({ pid, ws: `w${pid}`, repo: "app", command: "just test", queuedAtMs: pid, rank: 0, ...extra });

const name = (t: Ticket) => String(t.pid);

const runs = (command: string, ...ms: number[]): EstimateStore => ms.reduce<EstimateStore>((store, runMs) => withRun(store, "app", command, runMs), {});

describe("estimateFor", () => {
  test("is the median of the exact command's runs", () => {
    expect(estimateFor(runs("just test", 10_000, 30_000, 20_000), "app", "just test")).toEqual({ runMs: 20_000, runs: 3 });
    expect(estimateFor(runs("just test", 10_000, 30_000), "app", "just test")).toEqual({ runMs: 20_000, runs: 2 });
  });

  test("falls back to the command's group, and is undefined for another repo or a command never run", () => {
    const store = runs("just test a.ts", 40_000);
    expect(estimateFor(store, "app", "just test b.ts")).toEqual({ runMs: 40_000, runs: 1 });
    expect(estimateFor(store, "web", "just test a.ts")).toBeUndefined();
    expect(estimateFor(store, "app", "just lint")).toBeUndefined();
  });

  test("keeps only the newest runs, so a repo that got faster is estimated by its new speed", () => {
    const store = runs("just test", ...Array.from({ length: KEPT_RUNS }, () => 90_000), ...Array.from({ length: KEPT_RUNS }, () => 10_000));
    expect(store[estimateKeys("app", "just test")[0]]).toHaveLength(KEPT_RUNS);
    expect(estimateFor(store, "app", "just test")?.runMs).toBe(10_000);
  });

  test("the overall median stands in when nothing has finished", () => {
    expect(overallMs({})).toBe(60_000);
    expect(overallMs(runs("just test", 10_000, 50_000, 30_000))).toBe(30_000);
  });
});

describe("queueEtas", () => {
  const store = runs("just test", 60_000);

  test("a running check is done when its estimate runs out; one lane makes the waiting ones queue behind it", () => {
    const running = ticket(1, { runPid: 10, runningSinceMs: NOW_MS - 20_000 });
    const etas = queueEtas({ running: [running], waiting: [ticket(2), ticket(3)] }, store, 1, NOW_MS, name, 1);
    expect(etas.get("1")).toEqual({ startMs: 0, doneMs: 40_000, runMs: 60_000 });
    expect(etas.get("2")).toEqual({ startMs: 40_000, doneMs: 100_000, runMs: 60_000 });
    expect(etas.get("3")).toEqual({ startMs: 100_000, doneMs: 160_000, runMs: 60_000 });
  });

  test("two lanes start each waiting check on the lane that frees first", () => {
    const a = ticket(1, { runPid: 10, runningSinceMs: NOW_MS - 50_000 });
    const b = ticket(2, { runPid: 20, runningSinceMs: NOW_MS });
    const etas = queueEtas({ running: [a, b], waiting: [ticket(3), ticket(4)] }, store, 2, NOW_MS, name, 1);
    expect(etas.get("3")?.startMs).toBe(10_000);
    expect(etas.get("4")?.startMs).toBe(60_000);
  });

  test("an overdue run counts as finishing now, and an unknown command takes the fallback", () => {
    const late = ticket(1, { runPid: 10, runningSinceMs: NOW_MS - 600_000 });
    const etas = queueEtas({ running: [late], waiting: [ticket(2, { command: "make lint" })] }, store, 1, NOW_MS, name, 5_000);
    expect(etas.get("1")?.doneMs).toBe(0);
    expect(etas.get("2")).toEqual({ startMs: 0, doneMs: 5_000, runMs: undefined });
  });

  test("a workspace is done when its last check is", () => {
    const queue = { running: [ticket(1, { runPid: 10, runningSinceMs: NOW_MS, ws: "a" })], waiting: [ticket(2, { ws: "b" }), ticket(3, { ws: "a" })] };
    const done = workspaceDone(queue, queueEtas(queue, store, 1, NOW_MS, name, 1), name);
    expect(done).toEqual(new Map([["a", 180_000], ["b", 120_000]]));
  });

  test("lanes follow what runs now, at least one, at most max-parallel", () => {
    expect([etaSlots(0), etaSlots(3), etaSlots(3, 2)]).toEqual([1, 3, 2]);
  });
});

describe("the store file", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "estimates-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a run is appended, and a missing or bad file reads as empty", () => {
    expect(readEstimates(dir)).toEqual({});
    recordRunTime(dir, "app", "just test", 12_000);
    expect(estimateFor(readEstimates(dir), "app", "just test")?.runMs).toBe(12_000);
    writeFileSync(estimatesFile(dir), "{oops");
    expect(readEstimates(dir)).toEqual({});
    writeFileSync(estimatesFile(dir), JSON.stringify({ a: [1, "x"], b: [2] }));
    expect(readEstimates(dir)).toEqual({ b: [2] });
  });

  test("seeding builds a missing store and never replaces one", () => {
    seedEstimates(dir, [{ repo: "app", command: "just test", runMs: 30_000 }]);
    expect(estimateFor(readEstimates(dir), "app", "just test")?.runMs).toBe(30_000);
    seedEstimates(dir, [{ repo: "app", command: "just test", runMs: 99_000 }]);
    expect(JSON.parse(readFileSync(estimatesFile(dir), "utf8"))).toEqual(readEstimates(dir));
    expect(estimateFor(readEstimates(dir), "app", "just test")?.runMs).toBe(30_000);
  });
});

test("formatDuration", () => {
  expect([0, 42_000, 185_000, 7_620_000].map(formatDuration)).toEqual(["0s", "42s", "3m05s", "2h07m"]);
});
