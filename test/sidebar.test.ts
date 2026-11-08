import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentStateFile, glyphFor, readAgentState, UNKNOWN_GLYPH } from "../src/agent-state";
import { sidebarWidth } from "../src/config";
import { layoutKdl, SIDEBAR_WIDTH } from "../src/layout";
import { metaDir, reposFile } from "../src/paths";
import { clampScroll, type Entry, entryAt, entryLines, renderSidebar, scrollFor, sidebarLabel, stripConventional, switchTab, targetFor, wrapText } from "../src/sidebar";
import { type Input, textWidth } from "../src/term";

const entry = (ws: string, glyph = "○", label = ws): Entry => ({ ws, glyph, label });
const key = (k: string): Input => ({ kind: "key", key: k });
const list = Array.from({ length: 12 }, (_, i) => entry(`w${i + 1}`));

let tmp: string;
const savedRoot = process.env.OVERBRIDGE_ROOT;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "overbridge-sidebar-"));
  process.env.OVERBRIDGE_ROOT = tmp;
});

afterEach(() => {
  savedRoot === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = savedRoot);
  rmSync(tmp, { recursive: true, force: true });
});

describe("entry cards", () => {
  test("title line has key, glyph and label; status line the state; current is inverse", () => {
    const [title, sub] = entryLines({ ...entry("a", "●", "12 Add dark mode"), state: "waiting" }, 0, false, 22);
    expect(title!.trimEnd()).toBe("⌥1 ● 12 Add dark mode");
    expect(sub!).toContain("needs your input");
    expect(sub!).toContain("\x1b[33m");
    expect(entryLines(entry("b"), 1, true, 12)[0]).toBe("\x1b[7m⌥2 ○ b      \x1b[0m");
  });

  test("only the first nine entries get a key", () => {
    expect(entryLines(entry("x"), 8, false, 10)[0]!.startsWith("⌥9 ")).toBe(true);
    expect(entryLines(entry("x"), 9, false, 10)[0]!.startsWith("   ")).toBe(true);
  });

  test("a frame fits the height and width exactly, with a card per entry and the limits inside", () => {
    const rows = renderSidebar(list, 0, 0, 20, 30, undefined, 0);
    expect(rows).toHaveLength(20);
    for (const r of rows) expect(textWidth(r.replace(/\x1b\[[0-9;]*m/g, ""))).toBe(30);
    expect(rows[0]).toContain("Workspaces");
    expect(rows.at(-1)).toContain("╰");
    expect(rows.join("\n")).toContain("Hourly");
  });

  test("a window starts at the offset", () => {
    const rows = renderSidebar(list, 3, 3, 12, 30, undefined, 0);
    expect(rows[1]).toContain("⌥4 ");
  });
});

describe("scrolling", () => {
  const h12 = Array(12).fill(2);
  test("keeps the selected entry visible", () => {
    expect(scrollFor(2, 0, h12, 10)).toBe(0);
    expect(scrollFor(7, 0, h12, 10)).toBe(3);
    expect(scrollFor(1, 4, h12, 10)).toBe(1);
  });

  test("taller cards scroll sooner", () => {
    expect(scrollFor(3, 0, [3, 3, 3, 3], 8)).toBe(2);
  });

  test("clamps to the list", () => {
    expect(clampScroll(9, h12, 10)).toBe(7);
    expect(clampScroll(3, Array(4).fill(2), 20)).toBe(0);
  });

  test("entryAt maps cards of any height through the offset, skipping the border and the footer", () => {
    expect(entryAt(0, 0, [3, 2, 2], 20)).toBeUndefined();
    expect(entryAt(1, 0, [3, 2, 2], 20)).toBe(0);
    expect(entryAt(3, 0, [3, 2, 2], 20)).toBe(0);
    expect(entryAt(4, 0, [3, 2, 2], 20)).toBe(1);
    expect(entryAt(6, 0, [3, 2, 2], 20)).toBe(2);
    expect(entryAt(8, 0, [3, 2, 2], 20)).toBeUndefined();
    expect(entryAt(1, 1, [3, 2, 2], 20)).toBe(1);
    expect(entryAt(5, 0, [3, 2, 2], 4)).toBeUndefined();
  });
});

describe("wrapping", () => {
  test("wraps at spaces and splits over-long words", () => {
    expect(wrapText("add the thing now", 9)).toEqual(["add the", "thing now"]);
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapText("", 4)).toEqual([""]);
  });

  test("a long title wraps under its text, the status line last", () => {
    const lines = entryLines(entry("add a rather long title here"), 0, false, 20).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    expect(lines.length).toBeGreaterThan(2);
    for (const l of lines) expect(textWidth(l)).toBe(20);
    expect(lines[0]!.startsWith("⌥1 ")).toBe(true);
    expect(lines[1]!.startsWith("   ")).toBe(true);
  });
});

describe("targetFor", () => {
  const h = Array(12).fill(2);
  test("up/down and j/k step without wrapping", () => {
    expect(targetFor(key("down"), 2, 0, h, 20)).toBe(3);
    expect(targetFor(key("j"), 2, 0, h, 20)).toBe(3);
    expect(targetFor(key("up"), 2, 0, h, 20)).toBe(1);
    expect(targetFor(key("k"), 2, 0, h, 20)).toBe(1);
    expect(targetFor(key("up"), 0, 0, h, 20)).toBeUndefined();
    expect(targetFor(key("down"), 11, 0, h, 20)).toBeUndefined();
  });

  test("a digit jumps, out of range or the current tab does nothing", () => {
    expect(targetFor(key("5"), 0, 0, h, 20)).toBe(4);
    expect(targetFor(key("9"), 0, 0, Array(4).fill(2), 20)).toBeUndefined();
    expect(targetFor(key("1"), 0, 0, h, 20)).toBeUndefined();
    expect(targetFor(key("0"), 0, 0, h, 20)).toBeUndefined();
  });

  test("a click picks the row under it, through the scroll offset", () => {
    expect(targetFor({ kind: "click", col: 3, row: 3 }, 0, 4, h, 20)).toBe(5);
    expect(targetFor({ kind: "click", col: 3, row: 40 }, 0, 0, h, 20)).toBeUndefined();
  });

  test("other keys do nothing", () => {
    expect(targetFor(key("x"), 0, 0, h, 20)).toBeUndefined();
  });
});

describe("agent state", () => {
  test("glyphs for known states, a dot for none", () => {
    expect(glyphFor("busy")).toBe("🔄");
    expect(glyphFor("waiting")).toBe("❓");
    expect(glyphFor("bg")).toBe("⏳");
    expect(glyphFor(undefined)).toBe(UNKNOWN_GLYPH);
  });

  test("reads the recorded state, ignoring junk", () => {
    expect(readAgentState("w1")).toBeUndefined();
    mkdirSync(join(metaDir(), "agent"), { recursive: true });
    writeFileSync(agentStateFile("w1"), JSON.stringify({ state: "waiting", at: Date.now() }));
    expect(readAgentState("w1")).toBe("waiting");
    writeFileSync(agentStateFile("w1"), JSON.stringify({ state: "nonsense" }));
    expect(readAgentState("w1")).toBeUndefined();
    writeFileSync(agentStateFile("w1"), "not json");
    expect(readAgentState("w1")).toBeUndefined();
  });
});

describe("switchTab", () => {
  test("goes to the tab, then focuses its sidebar when known", () => {
    const calls: string[][] = [];
    switchTab("w2", (c) => calls.push(c));
    expect(calls).toEqual([["zellij", "action", "go-to-tab-name", "w2"]]);

    mkdirSync(join(metaDir(), "sidebars"), { recursive: true });
    writeFileSync(join(metaDir(), "sidebars", "w2"), "7\n");
    calls.length = 0;
    switchTab("w2", (c) => calls.push(c));
    expect(calls).toEqual([
      ["zellij", "action", "go-to-tab-name", "w2"],
      ["zellij", "action", "focus-pane-id", "terminal_7"],
    ]);
  });
});

describe("sidebar width", () => {
  test("defaults, reads the global config, and rejects nonsense", () => {
    expect(sidebarWidth()).toBe(SIDEBAR_WIDTH);
    writeFileSync(reposFile(), "[sidebar]\nwidth = 36\n");
    expect(sidebarWidth()).toBe(36);
    writeFileSync(reposFile(), "[sidebar]\nwidth = 3\n");
    expect(() => sidebarWidth()).toThrow("sidebar.width must be an integer from 12 to 200");
    writeFileSync(reposFile(), '[sidebar]\nwidth = "wide"\n');
    expect(() => sidebarWidth()).toThrow("sidebar.width");
  });

  test("the generated layout uses it", () => {
    expect(layoutKdl(["a"], ["overbridge"], { sidebarWidth: 36 })).toContain("size=36");
  });
});


describe("sidebarLabel", () => {
  test("drops the item id and a conventional prefix", () => {
    expect(sidebarLabel("w1", { headline: "ENG-12 feat(top): add dark mode", title: "feat(top): add dark mode" })).toBe("add dark mode");
    expect(sidebarLabel("w1", { headline: "12 Fix!: login loop" })).toBe("login loop");
    expect(sidebarLabel("w1", { title: "Refactor the parser" })).toBe("Refactor the parser");
  });
  test("falls back to the workspace name without a title, and keeps a title that is only a prefix", () => {
    expect(sidebarLabel("w1", {})).toBe("w1");
    expect(sidebarLabel("w1", { headline: "12" })).toBe("w1");
    expect(stripConventional("fix:")).toBe("fix:");
  });
});
