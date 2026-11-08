import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentStateFile, glyphFor, readAgentState, UNKNOWN_GLYPH } from "../src/agent-state";
import { sidebarWidth } from "../src/config";
import { layoutKdl, SIDEBAR_WIDTH } from "../src/layout";
import { metaDir, reposFile } from "../src/paths";
import { clampScroll, type Entry, entryAt, scrollFor, sidebarRows, switchTab, targetFor } from "../src/sidebar";
import type { Input } from "../src/term";

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

describe("rows", () => {
  test("digit, glyph and label, fitted to the width; current is inverse", () => {
    const rows = sidebarRows([entry("a", "●", "12 Add dark mode"), entry("b")], 0, 0, 5, 14);
    expect(rows[0]).toBe("\x1b[7m1 ● 12 Add da…\x1b[0m");
    expect(rows[1]).toBe("2 ○ b         ");
  });

  test("only the first nine rows get a digit", () => {
    const rows = sidebarRows(list, 0, 0, 12, 8);
    expect(rows[8]!.startsWith("9 ")).toBe(true);
    expect(rows[9]!.startsWith("  ")).toBe(true);
  });

  test("shows only the window", () => {
    expect(sidebarRows(list, 0, 3, 2, 8)).toHaveLength(2);
    expect(sidebarRows(list, 0, 3, 2, 8)[0]).toContain("4 ");
  });
});

describe("scrolling", () => {
  test("keeps the selected row visible", () => {
    expect(scrollFor(2, 0, 5)).toBe(0);
    expect(scrollFor(7, 0, 5)).toBe(3);
    expect(scrollFor(1, 4, 5)).toBe(1);
    expect(scrollFor(5, 3, 3)).toBe(3);
  });

  test("clamps to the list", () => {
    expect(clampScroll(9, 12, 5)).toBe(7);
    expect(clampScroll(3, 4, 10)).toBe(0);
  });

  test("entryAt maps screen rows through the offset", () => {
    expect(entryAt(0, 3, 12)).toBe(3);
    expect(entryAt(2, 10, 12)).toBeUndefined();
    expect(entryAt(-1, 0, 12)).toBeUndefined();
  });
});

describe("targetFor", () => {
  test("up/down and j/k step without wrapping", () => {
    expect(targetFor(key("down"), 2, 0, 12)).toBe(3);
    expect(targetFor(key("j"), 2, 0, 12)).toBe(3);
    expect(targetFor(key("up"), 2, 0, 12)).toBe(1);
    expect(targetFor(key("k"), 2, 0, 12)).toBe(1);
    expect(targetFor(key("up"), 0, 0, 12)).toBeUndefined();
    expect(targetFor(key("down"), 11, 0, 12)).toBeUndefined();
  });

  test("a digit jumps, out of range or the current tab does nothing", () => {
    expect(targetFor(key("5"), 0, 0, 12)).toBe(4);
    expect(targetFor(key("9"), 0, 0, 4)).toBeUndefined();
    expect(targetFor(key("1"), 0, 0, 12)).toBeUndefined();
    expect(targetFor(key("0"), 0, 0, 12)).toBeUndefined();
  });

  test("a click picks the row under it, through the scroll offset", () => {
    expect(targetFor({ kind: "click", col: 3, row: 1 }, 0, 4, 12)).toBe(5);
    expect(targetFor({ kind: "click", col: 3, row: 40 }, 0, 0, 12)).toBeUndefined();
  });

  test("other keys do nothing", () => {
    expect(targetFor(key("x"), 0, 0, 12)).toBeUndefined();
  });
});

describe("agent state", () => {
  test("glyphs for known states, a dot for none", () => {
    expect(glyphFor("busy")).toBe("●");
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
    expect(() => sidebarWidth()).toThrow("sidebar.width must be an integer from 12 to 80");
    writeFileSync(reposFile(), '[sidebar]\nwidth = "wide"\n');
    expect(() => sidebarWidth()).toThrow("sidebar.width");
  });

  test("the generated layout uses it", () => {
    expect(layoutKdl(["a"], ["overbridge"], { sidebarWidth: 36 })).toContain("size=36");
  });
});

