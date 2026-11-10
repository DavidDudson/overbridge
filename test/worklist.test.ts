import { describe, expect, test } from "bun:test";
import { isReady, keyOf, priorityOf, rank, statusFromColumn, streams, type WorkRow } from "../src/pm/worklist";

const row = (id: string, o: Partial<WorkRow> = {}): WorkRow => ({
  repo: "r",
  id,
  title: `item ${id}`,
  url: `https://example.test/${id}`,
  status: "todo",
  labels: [],
  blockedBy: [],
  updatedAt: `2026-01-${id.padStart(2, "0")}T00:00:00Z`,
  ...o,
});

const fixture = (): WorkRow[] => [
  row("1", { status: "done" }),
  row("2", { blockedBy: ["r#1"], labels: ["p1"] }),
  row("3", { blockedBy: ["r#2"] }),
  row("4", { labels: ["p0"] }),
  row("5", { parent: "r#6" }),
  row("6", { status: "in-progress" }),
  row("7", { blockedBy: ["other#9"] }),
  row("8", { labels: ["priority: high"] }),
];

describe("worklist", () => {
  test("priority labels", () => {
    expect(priorityOf(["p2", "p0"])).toBe(0);
    expect(priorityOf(["Priority: High"])).toBe(1);
    expect(priorityOf(["bug"])).toBe(9);
  });

  test("status from column", () => {
    expect(statusFromColumn("In Progress")).toBe("in-progress");
    expect(statusFromColumn("Done")).toBe("done");
    expect(statusFromColumn("Backlog")).toBe("todo");
    expect(statusFromColumn("Icebox", { icebox: "blocked" })).toBe("blocked");
    expect(statusFromColumn(undefined)).toBe("todo");
  });

  test("ready needs todo and every blocker done; unknown blocker is not done", () => {
    const rows = fixture();
    const by = new Map(rows.map((r) => [keyOf(r), r]));
    expect(isReady(by.get("r#2")!, by)).toBe(true);
    expect(isReady(by.get("r#3")!, by)).toBe(false);
    expect(isReady(by.get("r#7")!, by)).toBe(false);
    expect(isReady(by.get("r#6")!, by)).toBe(false);
  });

  test("streams group by blockers and parent, numbered stably", () => {
    const s = streams(fixture());
    expect(s.get("r#2")).toBe(s.get("r#3"));
    expect(s.get("r#1")).toBe(s.get("r#2"));
    expect(s.get("r#5")).toBe(s.get("r#6"));
    expect(s.get("r#4")).not.toBe(s.get("r#2"));
    expect(s.get("r#1")).toBe(1);
  });

  test("rank order follows the rules and explains itself", () => {
    const out = rank(fixture());
    expect(out.map((r) => r.key)).toEqual(["r#4", "r#2", "r#8", "r#5", "r#3", "r#6", "r#7"]);
    expect(out.find((r) => r.key === "r#1")).toBeUndefined();
    expect(out[0]!.reasons).toEqual(["ready", "priority p0"]);
    expect(out.find((r) => r.key === "r#2")!.reasons).toContain("unblocks 1");
    expect(out.find((r) => r.key === "r#5")!.reasons).toContain("parent in progress");
  });

  test("determinism: 100 shuffles give byte-identical output", () => {
    const base = JSON.stringify(rank(fixture()));
    let seed = 42;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
    for (let i = 0; i < 100; i++) {
      const rows = fixture();
      for (let j = rows.length - 1; j > 0; j--) {
        const k = Math.floor(rnd() * (j + 1));
        [rows[j], rows[k]] = [rows[k]!, rows[j]!];
      }
      expect(JSON.stringify(rank(rows))).toBe(base);
    }
  });
});
