import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EstimateStore, estimateFor, estimateKey, estimatesFile, etaSlots, etaSummary, formatDuration, lastDoneMs, seedRuns, KEPT_RUNS, queueEtas, readEstimates, recordRunTime, seedEstimates, withRun, workspaceDone } from "../src/check-estimate";
import type { Ticket } from "../src/check-queue";
import type { CheckRecord } from "../src/history";

const NOW_MS = 1_000_000;

const ticket = (pid: number, extra: Partial<Ticket> = {}): Ticket => ({ pid, ws: `w${pid}`, repo: "app", command: "just test", queuedAtMs: pid, rank: 0, ...extra });

const name = (t: Ticket) => String(t.pid);

const runs = (command: string, ...ms: number[]): EstimateStore => ms.reduce<EstimateStore>((store, runMs) => withRun(store, "app", command, runMs), {});

describe("estimateFor on long commands", () => {
  test("none for a command too long for its key to tell apart", () => {
    const prefix = `just test ${"a".repeat(600)}`;
    const store = withRun({}, "app", `${prefix} one`, 1_000);
    expect(estimateFor(store, "app", `${prefix} one`)).toBeUndefined();
    expect(estimateFor(store, "app", `${prefix} two`)).toBeUndefined();
  });
});

describe("estimateFor", () => {
  test("is the median of the exact command's runs", () => {
    expect(estimateFor(runs("just test", 10_000, 30_000, 20_000), "app", "just test")).toEqual({ runMs: 20_000, runs: 3 });
    expect(estimateFor(runs("just test", 10_000, 30_000), "app", "just test")).toEqual({ runMs: 20_000, runs: 2 });
  });

  test("matches only the exact command in the same repo", () => {
    const store = runs("just test a.ts", 40_000);
    expect(estimateFor(store, "app", "just test a.ts")).toEqual({ runMs: 40_000, runs: 1 });
    expect(estimateFor(store, "app", "just test b.ts")).toBeUndefined();
    expect(estimateFor(store, "app", "just test")).toBeUndefined();
    expect(estimateFor(store, "app", "just test a.ts --watch")).toBeUndefined();
    expect(estimateFor(store, "web", "just test a.ts")).toBeUndefined();
    expect(estimateFor(store, "app", "just lint")).toBeUndefined();
  });

  test("keeps only the newest runs, so a repo that got faster is estimated by its new speed", () => {
    const store = runs("just test", ...Array.from({ length: KEPT_RUNS }, () => 90_000), ...Array.from({ length: KEPT_RUNS }, () => 10_000));
    expect(store[estimateKey("app", "just test")]).toHaveLength(KEPT_RUNS);
    expect(estimateFor(store, "app", "just test")?.runMs).toBe(10_000);
  });

});

describe("queueEtas", () => {
  const store = runs("just test", 60_000);

  test("a running check is done when its estimate runs out; one lane makes the waiting ones queue behind it", () => {
    const running = ticket(1, { runPid: 10, runningSinceMs: NOW_MS - 20_000 });
    const etas = queueEtas({ running: [running], waiting: [ticket(2), ticket(3)] }, store, 1, NOW_MS, name);
    expect(etas.get("1")).toEqual({ startMs: 0, doneMs: 40_000, runMs: 60_000 });
    expect(etas.get("2")).toEqual({ startMs: 40_000, doneMs: 100_000, runMs: 60_000 });
    expect(etas.get("3")).toEqual({ startMs: 100_000, doneMs: 160_000, runMs: 60_000 });
  });

  test("two lanes start each waiting check on the lane that frees first", () => {
    const a = ticket(1, { runPid: 10, runningSinceMs: NOW_MS - 50_000 });
    const b = ticket(2, { runPid: 20, runningSinceMs: NOW_MS });
    const etas = queueEtas({ running: [a, b], waiting: [ticket(3), ticket(4)] }, store, 2, NOW_MS, name);
    expect(etas.get("3")?.startMs).toBe(10_000);
    expect(etas.get("4")?.startMs).toBe(60_000);
  });

  test("an overdue run counts as finishing now; a command never run gets a start but no run or finish", () => {
    const late = ticket(1, { runPid: 10, runningSinceMs: NOW_MS - 600_000 });
    const etas = queueEtas({ running: [late], waiting: [ticket(2, { command: "make lint" })] }, store, 1, NOW_MS, name);
    expect(etas.get("1")?.doneMs).toBe(0);
    expect(etas.get("2")).toEqual({ startMs: 0, doneMs: undefined, runMs: undefined });
  });

  test("a check with no estimate leaves every check behind it without a start", () => {
    const unknown = ticket(1, { runPid: 10, runningSinceMs: NOW_MS, command: "make lint" });
    const etas = queueEtas({ running: [unknown], waiting: [ticket(2), ticket(3)] }, store, 1, NOW_MS, name);
    expect(etas.get("1")).toEqual({ startMs: 0, doneMs: undefined, runMs: undefined });
    expect(etas.get("2")).toEqual({ startMs: undefined, doneMs: undefined, runMs: 60_000 });
    expect(etas.get("3")).toEqual({ startMs: undefined, doneMs: undefined, runMs: 60_000 });
  });

  test("with two lanes, a busy lane with no estimate still blocks the start, though the other lane is free", () => {
    const unknown = ticket(1, { runPid: 10, runningSinceMs: NOW_MS, command: "make lint" });
    const etas = queueEtas({ running: [unknown], waiting: [ticket(2)] }, store, 2, NOW_MS, name);
    expect(etas.get("2")).toEqual({ startMs: undefined, doneMs: undefined, runMs: 60_000 });
  });

  test("an unknown check waiting ahead blocks the start of those after it", () => {
    const etas = queueEtas({ running: [], waiting: [ticket(1, { command: "make lint" }), ticket(2)] }, store, 1, NOW_MS, name);
    expect(etas.get("1")).toEqual({ startMs: 0, doneMs: undefined, runMs: undefined });
    expect(etas.get("2")?.startMs).toBeUndefined();
  });

  test("a workspace is done when its last check is", () => {
    const queue = { running: [ticket(1, { runPid: 10, runningSinceMs: NOW_MS, ws: "a" })], waiting: [ticket(2, { ws: "b" }), ticket(3, { ws: "a" })] };
    const done = workspaceDone(queue, queueEtas(queue, store, 1, NOW_MS, name), name);
    expect(done).toEqual(new Map([["a", 180_000], ["b", 120_000]]));
  });

  test("a workspace with any check that cannot be estimated has no done time", () => {
    const queue = { running: [ticket(1, { runPid: 10, runningSinceMs: NOW_MS, ws: "a" })], waiting: [ticket(2, { ws: "b", command: "make lint" })] };
    const done = workspaceDone(queue, queueEtas(queue, store, 2, NOW_MS, name), name);
    expect(done).toEqual(new Map([["a", 60_000]]));
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
    writeFileSync(estimatesFile(dir), JSON.stringify({ "cmd app a": [1, "x"], "cmd app b": [2], "group app test": [3] }));
    expect(readEstimates(dir)).toEqual({ "cmd app b": [2], "group app test": [3] });
  });

  test("a run keeps keys this build does not read, so an older build sharing the file keeps them", () => {
    writeFileSync(estimatesFile(dir), JSON.stringify({ "group app test": [3] }));
    recordRunTime(dir, "app", "just test", 12_000);
    expect(readEstimates(dir)).toEqual({ "group app test": [3], [estimateKey("app", "just test")]: [12_000] });
  });

  test("seeding builds a missing store and never replaces one", () => {
    seedEstimates(dir, [{ repo: "app", command: "just test", runMs: 30_000 }]);
    expect(estimateFor(readEstimates(dir), "app", "just test")?.runMs).toBe(30_000);
    seedEstimates(dir, [{ repo: "app", command: "just test", runMs: 99_000 }]);
    expect(JSON.parse(readFileSync(estimatesFile(dir), "utf8"))).toEqual(readEstimates(dir));
    expect(estimateFor(readEstimates(dir), "app", "just test")?.runMs).toBe(30_000);
  });
});

test("lastDoneMs is the latest finish, or undefined when any is unknown", () => {
  expect([lastDoneMs([]), lastDoneMs([5_000, 9_000]), lastDoneMs([5_000, undefined])]).toEqual([0, 9_000, undefined]);
});

test.each([
  [undefined, ""],
  [{ startMs: undefined, doneMs: undefined, runMs: undefined }, ""],
  [{ startMs: 120_000, doneMs: undefined, runMs: undefined }, "; estimated start in ~2m00s"],
  [{ startMs: undefined, doneMs: undefined, runMs: 190_000 }, "; run ~3m10s"],
  [{ startMs: 120_000, doneMs: 310_000, runMs: 190_000 }, "; estimated start in ~2m00s, run ~3m10s"],
])("etaSummary(%o) is %p", (eta, text) => expect(etaSummary(eta)).toBe(text));

describe("seedRuns", () => {
  const checkRecord = (at: number, extra: Partial<CheckRecord> = {}): CheckRecord => ({ kind: "check", at, repo: "app", command: "just test", full: "just test a.ts", cls: "test", queuedMs: 0, runMs: 30_000, exit: 0, ...extra });
  const record = (at: number, extra: Partial<CheckRecord> = {}) => ({ record: checkRecord(at, extra) });

  test.each([
    ["a finished run is kept under its full command", record(1), [{ repo: "app", command: "just test a.ts", runMs: 30_000 }]],
    ["a run with no full command is dropped", record(1, { full: undefined }), []],
    ["a killed run is dropped", record(1, { killed: true }), []],
    ["a run that never started is dropped", record(1, { runMs: 0 }), []],
  ])("%s", (_, input, expected) => expect(seedRuns([input])).toEqual(expected));

  test("newest-first history seeds oldest first", () => {
    expect(seedRuns([record(2, { runMs: 2_000 }), record(1, { runMs: 1_000 })]).map((r) => r.runMs)).toEqual([1_000, 2_000]);
  });
});

test("formatDuration", () => {
  expect([0, 42_000, 185_000, 7_620_000].map(formatDuration)).toEqual(["0s", "42s", "3m05s", "2h07m"]);
});
