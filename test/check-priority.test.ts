import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classInfo,
  DEFAULT_CLASSES,
  defaultClassName,
  defaultKey,
  highest,
  Move,
  movedIndex,
  overridesPath,
  type PriorityClass,
  priorityOf,
  readOverrides,
  readOverridesForWrite,
  spreadKeys,
  writeOverrides,
} from "../src/check-priority";
import { byQueueOrder, comparatorFor, Gate, gateFor, queueComparator, readTickets, type Ticket, ticketName } from "../src/check-queue";
import { defaultCheckQueue } from "../src/project-config";

const ticket = (pid: number, queuedAtMs: number, extra: Partial<Ticket> = {}): Ticket => ({ pid, ws: `w${pid}`, repo: "app", command: "just test", queuedAtMs, ...extra });

const CLASSES: readonly PriorityClass[] = [
  { name: "feature", icon: "🚀" },
  { name: "tool", icon: "🌉" },
  { name: "debt", icon: "🧹" },
];

describe("classes", () => {
  test("the default class is the one marked, else the first", () => {
    expect(defaultClassName(DEFAULT_CLASSES)).toBe("normal");
    expect(defaultClassName(CLASSES)).toBe("feature");
  });

  test("classInfo ranks a name by its place; an unknown name gets the default's", () => {
    expect(classInfo(CLASSES, "debt")).toEqual({ name: "debt", rank: 2, icon: "🧹" });
    expect(classInfo(DEFAULT_CLASSES, "renamed")).toEqual({ name: "normal", rank: 1, icon: "🔹" });
  });

  test("highest picks the lowest rank, or none for no claims", () => {
    expect(highest([classInfo(CLASSES, "debt"), classInfo(CLASSES, "tool")])?.name).toBe("tool");
    expect(highest([])).toBeUndefined();
  });
});

describe("priorityOf", () => {
  const rules = [
    { priority: "tool", item: "^TIP-" },
    { priority: "debt", branch: "^chore/" },
  ];

  test("the first matching rule wins, else the fallback", () => {
    expect(priorityOf(rules, "feature", { branch: "chore/TIP-3-x", item: "TIP-3" })).toBe("tool");
    expect(priorityOf(rules, "feature", { branch: "chore/ENG-1-x", item: "ENG-1" })).toBe("debt");
    expect(priorityOf(rules, "feature", { branch: "feat/ENG-1-x", item: "ENG-1" })).toBe("feature");
  });

  test("a rule on a field the claim lacks never matches", () => {
    expect(priorityOf(rules, "feature", { branch: "task/foo" })).toBe("feature");
  });
});

describe("queue order by class", () => {
  const ranked = (pid: number, queuedAtMs: number, rank: number) => ticket(pid, queuedAtMs, { rank });

  test("lower rank first, then queue time", () => {
    const tickets = [ranked(1, 1, 2), ranked(2, 2, 1), ranked(3, 3, 0), ranked(4, 4, 0)];
    expect(tickets.toSorted(queueComparator()).map((t) => t.pid)).toEqual([3, 4, 2, 1]);
  });

  test("an override places a ticket by its own key", () => {
    const late = ranked(2, 2, 2);
    expect([ranked(1, 1, 0), late].toSorted(queueComparator({ [ticketName(late)]: defaultKey(0, 0) })).map((t) => t.pid)).toEqual([2, 1]);
  });

  test("a ticket from an older overbridge (no rank) puts everyone on time order, so both builds agree", () => {
    const tickets = [ranked(1, 1, 2), ticket(2, 2)];
    expect(comparatorFor(tickets, {})).toBe(byQueueOrder);
    expect(comparatorFor([ranked(1, 1, 2), ranked(2, 2, 0)], {})(ranked(2, 2, 0), ranked(1, 1, 2))).toBeLessThan(0);
  });

  test("a higher class queued later starts ahead of a waiting lower one, unless an override moves it", () => {
    const settings = defaultCheckQueue();
    const machine = { load1: 0, cores: 8, cpuPercent: 0 };
    const debt = ranked(1, 1, 2);
    const feature = ranked(2, 2, 0);
    expect(gateFor(feature, [debt, feature], settings, machine, 10)).toBe(Gate.Start);
    expect(gateFor(debt, [debt, feature], settings, machine, 10)).toBe(Gate.Queue);
    expect(gateFor(debt, [debt, feature], settings, machine, 10, { [ticketName(debt)]: 0 })).toBe(Gate.Start);
  });

  test("while a ticket from an older build is live, the gate uses time order and ignores overrides", () => {
    const settings = defaultCheckQueue();
    const machine = { load1: 0, cores: 8, cpuPercent: 0 };
    const legacy = ticket(1, 1);
    const debt = ranked(2, 2, 2);
    const feature = ranked(3, 3, 0);
    expect(gateFor(feature, [legacy, feature], settings, machine, 10)).toBe(Gate.Queue);
    expect(gateFor(feature, [feature], settings, machine, 10)).toBe(Gate.Start);
    expect(gateFor(debt, [legacy, debt, feature], settings, machine, 10, { [ticketName(debt)]: 0 })).toBe(Gate.Queue);
    expect(gateFor(debt, [debt, feature], settings, machine, 10, { [ticketName(debt)]: 0 })).toBe(Gate.Start);
  });

  test("the load cap counts a just-started run that sorts behind the waiting ticket", () => {
    const NOW_MS = 10_000_000;
    const fresh = ticket(1, 1, { rank: 2, runPid: 10, runningSinceMs: NOW_MS });
    const settled = { ...fresh, runningSinceMs: 0 };
    const feature = ranked(5, 5, 0);
    const nearLimit = { load1: 5, cores: 8, cpuPercent: 0 };
    const settings = { ...defaultCheckQueue(), maxLoadPercent: 70 };
    expect(gateFor(feature, [fresh, feature], settings, nearLimit, NOW_MS)).toBe(Gate.Load);
    expect(gateFor(feature, [settled, feature], settings, nearLimit, NOW_MS)).toBe(Gate.Start);
  });

  test("max-parallel counts runs that sort behind the waiting ticket", () => {
    const settings = { ...defaultCheckQueue(), maxParallel: 2 };
    const running = (pid: number) => ticket(pid, pid, { rank: 2, runPid: pid * 10, runningSinceMs: 0 });
    const feature = ranked(9, 9, 0);
    expect(gateFor(feature, [running(1), running(2), feature], settings, { load1: 0, cores: 8, cpuPercent: 0 }, 10_000_000)).toBe(Gate.Parallel);
  });
});

describe("movedIndex", () => {
  test("up, down, top and bottom", () => {
    expect(movedIndex(4, 2, Move.Up)).toBe(1);
    expect(movedIndex(4, 1, Move.Down)).toBe(2);
    expect(movedIndex(4, 2, Move.Top)).toBe(0);
    expect(movedIndex(4, 1, Move.Bottom)).toBe(3);
  });

  test("already at that end, or out of range, is no move", () => {
    expect(movedIndex(4, 0, Move.Up)).toBeUndefined();
    expect(movedIndex(4, 0, Move.Top)).toBeUndefined();
    expect(movedIndex(4, 3, Move.Down)).toBeUndefined();
    expect(movedIndex(4, 3, Move.Bottom)).toBeUndefined();
    expect(movedIndex(4, 9, Move.Up)).toBeUndefined();
  });
});

describe("spreadKeys", () => {
  test("keeps distinct keys and nudges ties apart", () => {
    expect(spreadKeys([30, 10, 20])).toEqual([10, 20, 30]);
    expect(spreadKeys([5, 5, 5, 7])).toEqual([5, 6, 7, 8]);
  });
});

describe("overrides file", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ob-order-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("round-trips, and readTickets applies it without reading it as a ticket", () => {
    const first = ticket(1, 1, { rank: 0 });
    const second = ticket(2, 2, { rank: 0 });
    [first, second].forEach((t) => writeFileSync(join(dir, ticketName(t)), JSON.stringify(t)));
    writeOverrides(dir, { [ticketName(second)]: -1 });
    expect(readOverrides(dir)).toEqual({ [ticketName(second)]: -1 });
    expect(readTickets(dir).map((t) => t.pid)).toEqual([2, 1]);
  });

  test("a ticket with a bad rank is skipped", () => {
    writeFileSync(join(dir, ticketName(ticket(1, 1))), JSON.stringify(ticket(1, 1, { rank: -1 })));
    expect(readTickets(dir)).toEqual([]);
  });

  test("for sorting, a missing or bad file means no overrides; non-numbers are dropped", () => {
    expect(readOverrides(dir)).toEqual({});
    writeFileSync(overridesPath(dir), "{nope");
    expect(readOverrides(dir)).toEqual({});
    writeFileSync(overridesPath(dir), JSON.stringify({ a: 1, b: "2", c: null }));
    expect(readOverrides(dir)).toEqual({ a: 1 });
  });

  test("for a write, a missing file is empty but a bad one throws, so it is never overwritten", () => {
    expect(readOverridesForWrite(dir)).toEqual({});
    writeFileSync(overridesPath(dir), "{nope");
    expect(() => readOverridesForWrite(dir)).toThrow("fix or delete it to move checks again");
  });
});
