import { describe, expect, test } from "bun:test";
import { type BoardItem, BoardStatus, explain, normalizeStatus, rank, Readiness, readiness, recommend, renderBoard, RULES, streams } from "../src/pm/board";
import { Screen } from "./helpers/screen";

/**
 * A board shaped like a real Projects v2 one (Status, Priority, Size, Area, Order) with GitHub `blockedBy` links:
 * two areas, one dependency chain, one item in progress, one blocked by label, one blocked by an item the board
 * didn't return, and one done.
 */
const item = (id: string, over: Partial<BoardItem> & { status: BoardStatus }): BoardItem => ({
  id,
  title: `Item ${id}`,
  url: `https://example.test/${id}`,
  labels: [],
  blockedBy: [],
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

const FIXTURE: readonly BoardItem[] = [
  item("10", { title: "Engine: rules core", status: BoardStatus.Ready, priority: 0, size: 3, labels: ["area:engine"], order: 1 }),
  item("11", { title: "Engine: rune effects", status: BoardStatus.Ready, priority: 1, size: 2, labels: ["area:engine"], blockedBy: ["10"], order: 2 }),
  item("12", { title: "Engine: rune display", status: BoardStatus.Backlog, priority: 1, size: 1, labels: ["area:engine"], blockedBy: ["11"], order: 3 }),
  item("20", { title: "Sheet: layout", status: BoardStatus.InProgress, rawStatus: "In progress", priority: 0, size: 4, labels: ["area:sheet"] }),
  item("21", { title: "Sheet: print view", status: BoardStatus.Ready, priority: 2, size: 2, labels: ["area:sheet"], createdAt: "2026-02-01T00:00:00Z" }),
  item("30", { title: "Importer: PDF", status: BoardStatus.Ready, priority: 1, size: 5, labels: ["area:importer", "blocked"] }),
  item("31", { title: "Importer: CSV", status: BoardStatus.Ready, priority: 1, size: 2, labels: ["area:importer"], dueAt: "2026-11-20T00:00:00Z" }),
  item("40", { title: "Legal page", status: BoardStatus.Ready, size: 1, blockedBy: ["999"] }),
  item("41", { title: "Fix typo", status: BoardStatus.Ready, size: 1, createdAt: "2025-12-01T00:00:00Z" }),
  item("42", { title: "Fix other typo", status: BoardStatus.Ready, size: 1, createdAt: "2025-12-01T00:00:00Z" }),
  item("50", { title: "Shipped", status: BoardStatus.Done }),
];

const ids = (rows: { item: BoardItem }[]) => rows.map((r) => r.item.id);

/** A seeded shuffle, so a failing order can be reproduced. */
function shuffled<T>(list: readonly T[], seed: number): T[] {
  const out = [...list];
  let s = seed;
  const next = () => (s = (s * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("normalizeStatus", () => {
  test.each([
    ["In progress", "in-progress"],
    ["Selected for Development", "in-progress"],
    ["In review", "in-review"],
    ["Ready", "ready"],
    ["To Do", "ready"],
    ["Backlog", "backlog"],
    ["Done", "done"],
    ["Weird column", "unknown"],
    [undefined, "unknown"],
  ])("%s -> %s", (raw, want) => expect<string>(normalizeStatus(raw)).toBe(want));

  test("a configured map wins, ignoring case", () => {
    expect(normalizeStatus("Weird column", { "weird column": BoardStatus.Ready })).toBe("ready");
  });
});

describe("readiness", () => {
  const byId = new Map(FIXTURE.map((i) => [i.id, i]));
  const of = (id: string) => readiness(byId.get(id)!, byId);

  test("no blockers is ready", () => expect(of("10")).toEqual({ readiness: Readiness.Ready, because: ["no open blockers"] }));
  test("an open blocker blocks, naming it", () => expect(of("11")).toEqual({ readiness: Readiness.Blocked, because: ["blocked by 10 (ready)"] }));
  test("a blocker off the board is assumed open", () => expect(of("40").because).toEqual(["blocked by 999 (not on the board, assumed open)"]));
  test("a blocked label blocks", () => expect(of("30").because).toEqual(["label blocked"]));
  test("in progress is active, showing the raw column", () => expect(of("20")).toEqual({ readiness: Readiness.Active, because: ["status In progress"] }));
  test("done is done", () => expect(of("50").readiness).toBe(Readiness.Done));
  test("a done blocker no longer blocks", () => {
    const all = new Map([...byId, ["10", { ...byId.get("10")!, status: BoardStatus.Done }]]);
    expect(readiness(all.get("11")!, all).readiness).toBe(Readiness.Ready);
  });
});

describe("streams", () => {
  test("dependency edges and shared area labels join items; the rest stand alone", () => {
    const s = streams(FIXTURE.filter((i) => i.status !== BoardStatus.Done));
    expect(s.get("10")).toBe("area:engine");
    expect(s.get("12")).toBe("area:engine");
    expect(s.get("20")).toBe("area:sheet");
    expect(s.get("21")).toBe("area:sheet");
    expect(s.get("30")).toBe("area:importer");
    expect(s.get("40")).toBe("#40");
    expect(s.get("41")).toBe("#41");
    expect(new Set(s.values()).size).toBe(6);
  });

  test("an edge joins items with different labels, named by the first label seen", () => {
    const s = streams([item("1", { status: BoardStatus.Ready, labels: ["area:a"] }), item("2", { status: BoardStatus.Ready, labels: ["area:b"], blockedBy: ["1"] })]);
    expect(s.get("1")).toBe(s.get("2"));
  });
});

describe("rank", () => {
  const ranked = rank(FIXTURE);

  test("ready first by priority, then active, then blocked; done left out", () => {
    // blocked: 11 unblocks one; 12 and 30 tie to board order, where 12 has one and 30 has none; 40 has no priority
    expect(ids(ranked)).toEqual(["10", "31", "21", "41", "42", "20", "11", "12", "30", "40"]);
    expect(ranked.map((r) => r.readiness)).toEqual(["ready", "ready", "ready", "ready", "ready", "active", "blocked", "blocked", "blocked", "blocked"]);
  });

  test("ranks are 1-based positions", () => expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));

  test("unblocks counts open items waiting on an item", () => {
    expect(ranked.find((r) => r.item.id === "10")!.unblocks).toBe(1);
    expect(ranked.find((r) => r.item.id === "11")!.unblocks).toBe(1);
    expect(ranked.find((r) => r.item.id === "21")!.unblocks).toBe(0);
  });

  test("explain names the deciding rule with both sides' facts", () => {
    const by = (id: string) => ranked.find((r) => r.item.id === id)!;
    expect(explain(by("10"), by("31"))).toBe("10 above 31: priority, p0 first, unset last (p0 vs p1)");
    expect(explain(by("31"), by("10"))).toBe("10 above 31: priority, p0 first, unset last (p0 vs p1)");
    expect(explain(by("41"), by("42"))).toBe("41 above 42: id (41 vs 42)");
    expect(explain(by("31"), by("21"))).toBe("31 above 21: priority, p0 first, unset last (p1 vs p2)");
    expect(explain(by("11"), by("30"))).toBe("11 above 30: unblocks the most open items (unblocks 1 vs unblocks 0)");
    expect(explain(by("20"), by("11"))).toBe("20 above 11: ready, then active, then blocked (active vs blocked)");
  });

  test("does not change its input", () => {
    const copy = structuredClone(FIXTURE);
    rank(copy);
    expect(copy).toEqual(FIXTURE);
  });
});

describe("determinism", () => {
  const want = ids(rank(FIXTURE));

  test("the same order from 200 shuffled inputs", () => {
    for (let seed = 1; seed <= 200; seed++) {
      expect(ids(rank(shuffled(FIXTURE, seed)))).toEqual(want);
    }
  });

  test("the same output twice, byte for byte", () => {
    expect(JSON.stringify(rank(FIXTURE))).toBe(JSON.stringify(rank(structuredClone(FIXTURE))));
  });

  test("the rules are a total order: no two open items tie, and comparison is antisymmetric", () => {
    const ranked = rank(FIXTURE);
    const cmp = (a: (typeof ranked)[number], b: (typeof ranked)[number]) => {
      for (const rule of RULES) {
        const [ka, kb] = [rule.key(a), rule.key(b)];
        if (ka !== kb) return typeof ka === "string" && typeof kb === "string" ? ka.localeCompare(kb, undefined, { numeric: true }) : ka < kb ? -1 : 1;
      }
      return 0;
    };
    for (const a of ranked) {
      for (const b of ranked) {
        if (a === b) expect(cmp(a, b)).toBe(0);
        else {
          expect(cmp(a, b)).not.toBe(0);
          expect(Math.sign(cmp(a, b))).toBe(-Math.sign(cmp(b, a)));
        }
      }
    }
  });

  test("the last rule is the id, so distinct ids never tie", () => {
    expect(RULES.at(-1)!.name).toBe("id");
  });
});

describe("recommend", () => {
  const ranked = rank(FIXTURE);

  test("one item per stream, idle streams first, up to the free slots", () => {
    const picks = recommend(ranked, 3);
    expect(picks.map((p) => p.item.id)).toEqual(["10", "31", "41"]);
    expect(picks.map((p) => p.stream)).toEqual(["area:engine", "area:importer", "#41"]);
    expect(picks[0]!.why).toEqual(["rank 1", "no open blockers", "stream area:engine has nothing active"]);
  });

  test("a stream with active work is offered only after the idle ones, and says so", () => {
    const picks = recommend(ranked, 6);
    expect(picks.map((p) => p.item.id)).toEqual(["10", "31", "41", "42", "21"]);
    expect(picks.at(-1)!.why.at(-1)).toBe("stream area:sheet already has active work; may collide");
  });

  test("no free slots recommends nothing", () => expect(recommend(ranked, 0)).toEqual([]));
});

describe("renderBoard", () => {
  test("fits the pane, shows the counts, the slot of a started item and why a blocked one waits", () => {
    const ranked = rank(FIXTURE);
    const slots = new Map([["20", { ws: "gh-pioneer-20", glyph: "🔄" }]]);
    const width = 100;
    const rows = renderBoard(ranked, slots, 0, width, 14);
    const screen = new Screen(width, rows.length).write(rows.map((r, y) => `\x1b[${y + 1};1H${r}`).join(""));
    const lines = screen.lines();
    expect(lines[0]).toContain("Board · 5 ready · 1 active · 4 blocked");
    expect(lines[1]).toContain("slot / waits on");
    expect(lines[2]).toMatch(/^│ 🟢 10 p0 3 Engine: rules core/);
    expect(screen.inverseRows()).toEqual([2]);
    expect(lines.find((l) => l.includes(" 20 "))).toContain("🔄 gh-pioneer-20");
    expect(lines.find((l) => l.includes(" 11 "))).toContain("blocked by 10 (ready)");
    expect(lines.find((l) => l.includes(" 40 "))).toContain("assumed open");
    expect(lines.at(-1)).toContain("⏎ start in a slot");
    expect(rows.length).toBe(14);
    // the Screen clips instead of wrapping, so an overflowing row would lose its right border
    for (const line of lines) expect(line.endsWith("│") || line.endsWith("╮") || line.endsWith("╯")).toBe(true);
  });
});
