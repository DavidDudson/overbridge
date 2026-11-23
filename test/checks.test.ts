import { describe, expect, test } from "bun:test";
import { Move, type QueueOverrides } from "../src/check-priority";
import { Outcome, outcomeOf, queueComparator, queueView, type Ticket, ticketName } from "../src/check-queue";
import { type CheckRow, checkRows, formatDuration, movedOverrides, queueEstimates, nextChecksMode, ChecksMode, recentChecks, recentTotals, renderChecks, renderRecent } from "../src/checks";
import { withRun } from "../src/check-estimate";
import type { CheckRecord, HistoryRecord, HistoryStore } from "../src/history";

// eslint-disable-next-line no-control-regex -- stripping colour codes is the point
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const ticket = (pid: number, queuedAtMs: number, extra: Partial<Ticket> = {}): Ticket => ({ pid, ws: `w${pid}`, repo: "app", command: "just test", queuedAtMs, rank: 0, icon: "🚀", ...extra });

const running = ticket(1, 1_000, { runPid: 11, runningSinceMs: 2_000 });
const a = ticket(2, 3_000);
const b = ticket(3, 4_000, { rank: 1, icon: "💡" });
const c = ticket(4, 5_000, { rank: 2, icon: "🧹" });
const all = [running, a, b, c];

const rowsFor = (tickets: Ticket[], overrides: QueueOverrides): CheckRow[] => checkRows(queueView(tickets.toSorted(queueComparator(overrides))), overrides);

/** Apply `move` to the check with `pid`, failing the test when the move is refused. */
const moved = (tickets: Ticket[], overrides: QueueOverrides, pid: number, move: Move): QueueOverrides => {
  const rows = rowsFor(tickets, overrides);

  const next = movedOverrides(
    rows,
    rows.findIndex((r) => r.ticket.pid === pid),
    move,
    overrides,
  );

  if (!next) {
    throw new Error(`move ${move} of ${pid} was refused`);
  }

  return next;
};

const order = (tickets: Ticket[], overrides: QueueOverrides) => rowsFor(tickets, overrides).map((r) => r.ticket.pid);

describe("movedOverrides", () => {
  test("moves a waiting check and keeps it among the waiting ones", () => {
    expect(order(all, moved(all, {}, 4, Move.Top))).toEqual([1, 4, 2, 3]);
  });

  test("a run of moves builds on the earlier ones", () => {
    const steps: [number, Move, number[]][] = [
      [4, Move.Top, [1, 4, 2, 3]],
      [3, Move.Top, [1, 3, 4, 2]],
      [4, Move.Up, [1, 4, 3, 2]],
      [4, Move.Bottom, [1, 3, 2, 4]],
      [2, Move.Up, [1, 2, 3, 4]],
    ];

    steps.reduce<QueueOverrides>((overrides, [pid, move, expected]) => {
      const next = moved(all, overrides, pid, move);
      expect(order(all, next)).toEqual(expected);

      return next;
    }, {});
  });

  test("checks with the same key still move", () => {
    const twins = [ticket(5, 7_000), ticket(6, 7_000), ticket(7, 7_000)];
    expect(order(twins, moved(twins, {}, 7, Move.Up))).toEqual([5, 7, 6]);
  });

  test("refuses a running check or one already at that end", () => {
    const rows = rowsFor(all, {});
    expect(movedOverrides(rows, 0, Move.Down, {})).toBeUndefined();
    expect(movedOverrides(rows, 1, Move.Up, {})).toBeUndefined();
    expect(movedOverrides(rows, 3, Move.Bottom, {})).toBeUndefined();
  });

  test("drops overrides for tickets that left the queue", () => {
    expect(Object.keys(moved(all, { "gone.json": 5 }, 3, Move.Up)).toSorted()).toEqual([a, b, c].map(ticketName).toSorted());
  });
});

describe("renderChecks", () => {
  test("shows running then waiting with each ticket's icon, and the counts", () => {
    const out = renderChecks(rowsFor(all, {}), { selected: 1, offset: 0, height: 10, width: 90, message: "", now: 6_000 }).map(strip);
    expect(out[0]).toContain("Check queue");
    expect(out[2]).toContain("🚀 w1");
    expect(out[2]).toContain("▶ 4s");
    expect(out[4]).toContain("💡 w3");
    expect(out[5]).toContain("🧹 w4");
    expect(out.at(-1)).toContain("1 running · 3 waiting");
  });

  test("an empty queue says how to queue a check", () => {
    const out = renderChecks([], { selected: 0, offset: 0, height: 8, width: 90, message: "", now: 0 }).map(strip);
    expect(out[2]).toContain("no checks queued");
  });
});

const checkRecord = (at: number, extra: Partial<CheckRecord> = {}): CheckRecord => ({
  kind: "check",
  at,
  repo: "app",
  command: "just test",
  full: "just test --all",
  cls: "test",
  queuedMs: 5_000,
  runMs: 65_000,
  exit: 0,
  ...extra,
});

const storeOf = (byWs: Record<string, HistoryRecord[]>): HistoryStore => ({
  append: () => undefined,
  read: (ws, sinceMs = 0) => (byWs[ws] ?? []).filter((r) => r.at >= sinceMs),
  workspaces: () => Object.keys(byWs),
});

describe("recent checks", () => {
  const claude: HistoryRecord = { kind: "claude", at: 3_000, event: "Stop" };

  test("lists check runs from every workspace, newest first, within the window and the limit", () => {
    const store = storeOf({ one: [checkRecord(1_000), claude, checkRecord(4_000)], two: [checkRecord(2_000), checkRecord(500)] });
    expect(recentChecks(store, 900).map((r) => [r.ws, r.record.at])).toEqual([
      ["one", 4_000],
      ["two", 2_000],
      ["one", 1_000],
    ]);
    expect(recentChecks(store, 0, 2).map((r) => r.record.at)).toEqual([4_000, 2_000]);
  });

  test("names how each run ended from its exit code", () => {
    expect([0, 1, 143, 75, 124, 137].map((exit) => outcomeOf({ exit }))).toEqual([Outcome.Passed, Outcome.Failed, Outcome.Failed, Outcome.GaveUp, Outcome.TimedOut, Outcome.Stalled]);
    expect(outcomeOf({ exit: 143, killed: true })).toBe(Outcome.Killed);
  });

  test("durations read as seconds, minutes or hours", () => {
    expect([0, 42_000, 185_000, 7_620_000].map(formatDuration)).toEqual(["0s", "42s", "3m05s", "2h07m"]);
  });

  test("the view toggles between the queue and the recent runs", () => {
    expect(nextChecksMode(ChecksMode.Queue)).toBe(ChecksMode.Recent);
    expect(nextChecksMode(ChecksMode.Recent)).toBe(ChecksMode.Queue);
  });

  test("totals count runs that were not ok and the time run and waited", () => {
    const rows = [checkRecord(1, { exit: 1 }), checkRecord(2), checkRecord(3, { exit: 143, runMs: 0, killed: true })].map((record) => ({ ws: "w", record }));
    expect(recentTotals(rows)).toBe("3 runs · 2 not ok · ran 2m10s · waited 15s");
  });

  test("renders one row per run with its result, wait, run time and full command", () => {
    const NOW_MS = 1_000_000;

    const rows = [
      { ws: "alpha", record: checkRecord(NOW_MS - 30_000, { exit: 2 }) },
      { ws: "beta", record: checkRecord(NOW_MS - 120_000, { exit: 75, runMs: 0, full: undefined }) },
    ];

    const lines = renderRecent(rows, { selected: 0, offset: 0, height: 8, width: 140, message: "", now: NOW_MS }).map(strip);

    expect(lines[0]).toContain("Recent checks (24h)");
    expect(lines[2]).toMatch(/30s ago\s+alpha\s+app\s+✗ exit 2\s+5s\s+1m05s\s+just test --all/);
    expect(lines[3]).toMatch(/2m00s ago\s+beta\s+app\s+⧗ gave up\s+5s\s+-\s+just test /);
    expect(lines.at(-2)).toContain("v queue");
    expect(lines.at(-1)).toContain("2 runs · 2 not ok");
  });

  test("an empty window says so", () => {
    const lines = renderRecent([], { selected: 0, offset: 0, height: 6, width: 80, message: "", now: 0 }).map(strip);
    expect(lines[2]).toContain("no checks finished in this window");
  });
});

describe("queue estimates", () => {
  test("each row shows its usual run time and its start or time left, and the border when the queue clears", () => {
    const NOW_MS = 100_000;
    const store = withRun({}, "app", "just test", 60_000);
    const live = { running: [ticket(1, NOW_MS - 50_000, { runPid: 11, runningSinceMs: NOW_MS - 20_000 })], waiting: [ticket(2, NOW_MS - 40_000), ticket(3, NOW_MS - 30_000, { command: "make lint" })] };
    const estimates = queueEstimates(live, store, NOW_MS);
    const lines = renderChecks(checkRows(live, {}), { selected: 9, offset: 0, height: 9, width: 140, message: "", now: NOW_MS }, estimates).map(strip);

    expect(lines[1]).toMatch(/state\s+est\s+eta\s+command/);
    expect(lines[2]).toMatch(/▶ 20s\s+~1m00s\s+done ~40s\s+just test/);
    expect(lines[3]).toMatch(/⧗ 40s\s+~1m00s\s+start ~40s\s+just test/);
    expect(lines[4]).toMatch(/⧗ 30s\s+\?\s+start ~1m40s\s+make lint/);
    expect(lines.at(-1)).toContain("1 running · 2 waiting");
    expect(lines.at(-1)).not.toContain("clear");
    expect(estimates.clearMs).toBeUndefined();
    expect(estimates.wsDoneMs.get("w2")).toBe(100_000);
    expect(estimates.wsDoneMs.has("w3")).toBe(false);
  });

  test("the border shows when the queue clears once every check has an estimate", () => {
    const NOW_MS = 100_000;
    const store = withRun({}, "app", "just test", 60_000);
    const live = { running: [ticket(1, NOW_MS - 50_000, { runPid: 11, runningSinceMs: NOW_MS - 20_000 })], waiting: [ticket(2, NOW_MS - 40_000), ticket(3, NOW_MS - 30_000)] };
    const estimates = queueEstimates(live, store, NOW_MS);
    const lines = renderChecks(checkRows(live, {}), { selected: 9, offset: 0, height: 9, width: 140, message: "", now: NOW_MS }, estimates).map(strip);

    expect(estimates.clearMs).toBe(160_000);
    expect(lines.at(-1)).toContain("1 running · 2 waiting · clear ~2m40s");
  });

  test("a running check with no estimate shows no time left and is never overdue", () => {
    const NOW_MS = 100_000;
    const live = { running: [ticket(1, NOW_MS - 50_000, { runPid: 11, runningSinceMs: NOW_MS - 20_000, command: "make lint" })], waiting: [] };
    const lines = renderChecks(checkRows(live, {}), { selected: 9, offset: 0, height: 9, width: 140, message: "", now: NOW_MS }, queueEstimates(live, {}, NOW_MS)).map(strip);

    expect(lines[2]).toMatch(/▶ 20s\s+\?\s+make lint/);
    expect(lines[2]).not.toMatch(/overdue|done ~/);
  });
});
