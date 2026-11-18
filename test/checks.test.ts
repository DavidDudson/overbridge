import { describe, expect, test } from "bun:test";
import { Move, Priority } from "../src/check-priority";
import { queueView, type Ticket, ticketName } from "../src/check-queue";
import { checkRows, movedOrder, renderChecks } from "../src/checks";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const ticket = (pid: number, queuedAtMs: number, extra: Partial<Ticket> = {}): Ticket => ({ pid, ws: `w${pid}`, repo: "app", command: "just test", queuedAtMs, ...extra });

const running = ticket(1, 1_000, { runPid: 11, runningSinceMs: 2_000 });
const a = ticket(2, 3_000);
const b = ticket(3, 4_000, { priority: Priority.Tip });
const c = ticket(4, 5_000, { priority: Priority.TechDebt });
const rows = checkRows(queueView([running, a, b, c]), {});

describe("movedOrder", () => {
  test("moves a waiting check and keeps it among the waiting ones", () => {
    const order = movedOrder(rows, 3, Move.Top, {})!;
    expect(checkRows(queueView([running, a, b, c]), order).map((r) => r.ticket.pid)).toEqual([1, 4, 2, 3]);
  });

  test("refuses a running check or one already at that end", () => {
    expect(movedOrder(rows, 0, Move.Down, {})).toBeUndefined();
    expect(movedOrder(rows, 1, Move.Up, {})).toBeUndefined();
    expect(movedOrder(rows, 3, Move.Bottom, {})).toBeUndefined();
  });

  test("drops overrides for tickets that left the queue", () => {
    const order = movedOrder(rows, 2, Move.Up, { "gone.json": 5 })!;
    expect(Object.keys(order)).toEqual([ticketName(b)]);
  });
});

describe("renderChecks", () => {
  test("shows running then waiting with class icons, and the counts", () => {
    const out = renderChecks(rows, { selected: 1, offset: 0, height: 10, width: 90, message: "", now: 6_000 }).map(strip);
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
