import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultKey, highest, Move, moveKey, orderPath, Priority, priorityOf, readOrder, writeOrder } from "../src/check-priority";
import { byQueueOrder, Gate, gateFor, queueOrder, readTickets, type Ticket, ticketName } from "../src/check-queue";
import { defaultCheckQueue } from "../src/project-config";

const ticket = (pid: number, queuedAtMs: number, extra: Partial<Ticket> = {}): Ticket => ({ pid, ws: `w${pid}`, repo: "app", command: "just test", queuedAtMs, ...extra });

describe("priorityOf", () => {
  const settings = {
    fallback: Priority.Feature,
    rules: [
      { priority: Priority.Tip, item: "^TIP-" },
      { priority: Priority.TechDebt, branch: "^chore/" },
    ],
  };

  test("the first matching rule wins, else the fallback", () => {
    expect(priorityOf(settings, { branch: "chore/TIP-3-x", item: "TIP-3" })).toBe(Priority.Tip);
    expect(priorityOf(settings, { branch: "chore/ENG-1-x", item: "ENG-1" })).toBe(Priority.TechDebt);
    expect(priorityOf(settings, { branch: "feat/ENG-1-x", item: "ENG-1" })).toBe(Priority.Feature);
  });

  test("a rule on a field the claim lacks never matches", () => {
    expect(priorityOf(settings, { branch: "task/foo" })).toBe(Priority.Feature);
    expect(priorityOf({ fallback: Priority.Overbridge, rules: [] }, {})).toBe(Priority.Overbridge);
  });
});

describe("highest", () => {
  test("picks the class that starts first, or the default for none", () => {
    expect(highest([Priority.TechDebt, Priority.Overbridge, Priority.Tip])).toBe(Priority.Overbridge);
    expect(highest([])).toBe(Priority.Feature);
  });
});

describe("queue order by priority", () => {
  test("feature, then overbridge, then TIP, then tech debt; each class by queue time", () => {
    const tickets = [
      ticket(1, 1, { priority: Priority.TechDebt }),
      ticket(2, 2, { priority: Priority.Tip }),
      ticket(3, 3, { priority: Priority.Overbridge }),
      ticket(4, 4),
      ticket(5, 5, { priority: Priority.Feature }),
    ];

    expect(tickets.toSorted(byQueueOrder).map((t) => t.pid)).toEqual([4, 5, 3, 2, 1]);
  });

  test("an override places a ticket by its own key", () => {
    const late = ticket(2, 2, { priority: Priority.TechDebt });
    const order = { [ticketName(late)]: defaultKey(Priority.Feature, 0) };
    expect([ticket(1, 1), late].toSorted(queueOrder(order)).map((t) => t.pid)).toEqual([2, 1]);
  });

  test("a higher class queued later starts ahead of a waiting lower one", () => {
    const settings = defaultCheckQueue();
    const machine = { load1: 0, cores: 8 };
    const debt = ticket(1, 1, { priority: Priority.TechDebt });
    const feature = ticket(2, 2);
    expect(gateFor(feature, [debt, feature], settings, machine, 10)).toBe(Gate.Start);
    expect(gateFor(debt, [debt, feature], settings, machine, 10)).toBe(Gate.Queue);
    expect(gateFor(debt, [debt, feature], settings, machine, 10, { [ticketName(debt)]: 0 })).toBe(Gate.Start);
  });
});

describe("moveKey", () => {
  const waiting = [10, 20, 30, 40].map((key) => ({ name: String(key), key }));

  const after = (index: number, move: Move) => {
    const key = moveKey(waiting, index, move);

    return key === undefined ? undefined : waiting.map((w, i) => (i === index ? { ...w, key } : w)).toSorted((a, b) => a.key - b.key).map((w) => w.name);
  };

  test("up and down swap with the neighbour", () => {
    expect(after(2, Move.Up)).toEqual(["10", "30", "20", "40"]);
    expect(after(1, Move.Up)).toEqual(["20", "10", "30", "40"]);
    expect(after(1, Move.Down)).toEqual(["10", "30", "20", "40"]);
    expect(after(2, Move.Down)).toEqual(["10", "20", "40", "30"]);
  });

  test("top and bottom go to the ends", () => {
    expect(after(2, Move.Top)).toEqual(["30", "10", "20", "40"]);
    expect(after(1, Move.Bottom)).toEqual(["10", "30", "40", "20"]);
  });

  test("a check already at that end does not move", () => {
    expect(moveKey(waiting, 0, Move.Up)).toBeUndefined();
    expect(moveKey(waiting, 0, Move.Top)).toBeUndefined();
    expect(moveKey(waiting, 3, Move.Down)).toBeUndefined();
    expect(moveKey(waiting, 3, Move.Bottom)).toBeUndefined();
    expect(moveKey(waiting, 9, Move.Up)).toBeUndefined();
  });
});

describe("order file", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ob-order-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("round-trips, and readTickets applies it without reading it as a ticket", () => {
    const first = ticket(1, 1);
    const second = ticket(2, 2);
    [first, second].forEach((t) => writeFileSync(join(dir, ticketName(t)), JSON.stringify(t)));
    writeOrder(dir, { [ticketName(second)]: -1 });
    expect(readOrder(dir)).toEqual({ [ticketName(second)]: -1 });
    expect(readTickets(dir).map((t) => t.pid)).toEqual([2, 1]);
  });

  test("a missing or bad file means no overrides; non-numbers are dropped", () => {
    expect(readOrder(dir)).toEqual({});
    writeFileSync(orderPath(dir), "{nope");
    expect(readOrder(dir)).toEqual({});
    writeFileSync(orderPath(dir), JSON.stringify({ a: 1, b: "2", c: null }));
    expect(readOrder(dir)).toEqual({ a: 1 });
  });
});
