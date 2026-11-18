import { describe, expect, test } from "bun:test";
import { Move, type QueueOverrides } from "../src/check-priority";
import { queueComparator, queueView, type Ticket, ticketName } from "../src/check-queue";
import { type CheckRow, checkRows, movedOverrides, renderChecks } from "../src/checks";

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
