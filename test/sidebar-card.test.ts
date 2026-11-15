import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sidebarLayout } from "../src/config";
import { reposFile } from "../src/paths";
import { type Entry, EMPTY_PROMPT, entryHeight, entryHeights, entryLines, FooterKind, legend, queueRows, renderSidebar, Section } from "../src/sidebar";
import { COMPACT_BELOW, type CardView, contextLegend, isCompact, lastToolCalls, promptWithHint, recentTools } from "../src/sidebar-card";
import type { Limits } from "../src/limits";
import { fit, textWidth } from "../src/term";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const entry = (tab: string, over: Partial<Entry> = {}): Entry => ({ tab, section: Section.Workspaces, glyph: "🔄", label: tab, ...over });
const stacked = entry("a", { label: "12 Add dark mode to the settings page", state: "busy", stacks: [{ prs: [1, 2, 3], current: 2 }], prs: [{ number: 2, status: "failing" }] });

let tmp: string;
const savedRoot = process.env.OVERBRIDGE_ROOT;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "overbridge-card-"));
  process.env.OVERBRIDGE_ROOT = tmp;
});
afterEach(() => {
  savedRoot === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = savedRoot);
  rmSync(tmp, { recursive: true, force: true });
});

describe("layout", () => {
  test("auto is compact below the threshold; compact and wide force", () => {
    expect(isCompact("auto", COMPACT_BELOW - 1)).toBe(true);
    expect(isCompact("auto", COMPACT_BELOW)).toBe(false);
    expect(isCompact("compact", 200)).toBe(true);
    expect(isCompact("wide", 12)).toBe(false);
  });

  test("[sidebar] layout reads repos.toml: auto by default, rejects unknown values", () => {
    expect(sidebarLayout()).toBe("auto");
    writeFileSync(reposFile(), '[sidebar]\nlayout = "compact"\n');
    expect(sidebarLayout()).toBe("compact");
    writeFileSync(reposFile(), '[sidebar]\nlayout = "tiny"\n');
    expect(() => sidebarLayout()).toThrow("sidebar.layout");
  });

  test("a compact card drops the stack lines and the status row", () => {
    const wide = entryLines(stacked, 0, false, 30);
    const compact = entryLines(stacked, 0, false, 30, { compact: true });
    expect(wide.length - compact.length).toBe(2);
    expect(plain(compact.join("\n"))).not.toContain("stack");
    expect(plain(compact.join("\n"))).not.toContain("working");
    expect(entryHeight(stacked, 0, 30, { compact: true })).toBe(compact.length);
  });

  test("a compact card keeps its status row when something needs attention", () => {
    const blocked = entry("b", { blocked: "merged-unsaved" });
    expect(plain(entryLines(blocked, 0, false, 30, { compact: true }).join("\n"))).toContain("merged · unsaved work");
    expect(entryHeight(blocked, 0, 30, { compact: true })).toBe(2);
  });
});

describe("expanded card", () => {
  const view: CardView = { expanded: { tab: "a", now: 100_000, tools: [{ label: "Bash:test", at: 97_000 }, { label: "Edit", at: 60_000 }] } };

  test("shows the full title, PR number, CI state and last tool calls", () => {
    const text = plain(entryLines(stacked, 0, false, 30, view).join("\n"));
    expect(text).toContain("12 Add dark mode");
    expect(text).toContain("settings page");
    expect(text).toContain("PR #2 · failing");
    expect(text).toContain("CI failing");
    expect(text).toContain("Bash:test 3s");
    expect(text).toContain("Edit 40s");
  });

  test("its height matches its lines and only the named tab expands", () => {
    expect(entryHeight(stacked, 0, 30, view)).toBe(entryLines(stacked, 0, true, 30, view).length);
    expect(entryHeights([stacked, entry("b")], 34, view)[1]).toBe(2);
  });

  test("a card with no PR or calls says so", () => {
    const text = plain(entryLines(entry("a"), 0, false, 30, { expanded: { tab: "a", tools: [], now: 0 } }).join("\n"));
    expect(text).toContain("no PR yet");
    expect(text).toContain("no tool calls yet");
  });
});

describe("context legend", () => {
  const base = legend(3);
  test("changes with the selected card", () => {
    expect(contextLegend(entry("a"), base, false)).toEndWith("␣ more");
    expect(contextLegend(entry("a", { error: "x" }), base, false)).toStartWith("⚠ blocked");
    expect(contextLegend(entry("a", { prs: [{ number: 1, status: "mergeable" }] }), base, false)).toStartWith("✓ mergeable");
    expect(contextLegend(entry("a"), base, true)).toStartWith("␣ close");
    expect(contextLegend(undefined, base, false)).toBe(base);
    expect(contextLegend(entry("a"), "1…", false, "1")).toBe("1…");
  });

  test("the prompt row gets a key hint only when it fits", () => {
    expect(plain(promptWithHint("new ws: █", 40)!)).toContain("esc cancel");
    expect(textWidth(plain(promptWithHint("new ws: █", 40)!))).toBe(40);
    expect(promptWithHint("new ws: █", 20)).toBeUndefined();
  });
});

describe("recent tool calls", () => {
  const line = (r: object) => JSON.stringify({ kind: "claude", ...r });
  const text = [line({ at: 1, event: "PreToolUse", tool: "Read" }), line({ at: 2, event: "PostToolUse", tool: "Read" }), line({ at: 3, event: "PreToolUse", tool: "Bash", cls: "test" }), "{cut", line({ at: 4, event: "PreToolUse", tool: "Edit" }), line({ at: 5, event: "Stop" })].join("\n");

  test("takes the newest PreToolUse records, newest first, skipping bad lines", () => {
    expect(lastToolCalls(text, 3).map((c) => c.label)).toEqual(["Edit", "Bash:test", "Read"]);
    expect(lastToolCalls(text, 1)).toHaveLength(1);
  });

  test("reads the file tail and caches until the file changes", () => {
    const file = join(tmp, "h.jsonl");
    writeFileSync(file, text + "\n");
    const first = recentTools("x", 3, file);
    expect(recentTools("x", 3, file)).toBe(first);
    appendFileSync(file, line({ at: 9, event: "PreToolUse", tool: "Grep" }) + "\n");
    expect(recentTools("x", 3, file)[0]!.label).toBe("Grep");
    expect(recentTools("x", 3, join(tmp, "missing"))).toEqual([]);
  });

  test("a long history is read from its end only", () => {
    const file = join(tmp, "big.jsonl");
    mkdirSync(tmp, { recursive: true });
    writeFileSync(file, line({ at: 1, event: "PreToolUse", tool: "Old" }) + "\n" + (line({ at: 2, event: "Stop" }) + "\n").repeat(2000) + line({ at: 3, event: "PreToolUse", tool: "New" }) + "\n");
    expect(recentTools("y", 3, file).map((c) => c.label)).toEqual(["New"]);
  });
});

describe("no row spills past the pane", () => {
  const list: Entry[] = [
    entry("@root", { section: Section.Orchestration, glyph: "🧭", label: "Root" }),
    stacked,
    entry("b", { glyph: "❓", state: "waiting", label: "日本語のとても長いタイトルが入ります and more words", error: "the pre-remove hook failed with a long message" }),
    entry("c", { label: "supercalifragilisticexpialidocious-unbroken-word", state: "done", blocked: "merged-unsaved", prs: [{ number: 7, status: "mergeable" }] }),
    entry("d", { fault: "bad cache", label: "d" }),
  ];
  const limits: Limits = { at: 1, fiveHour: { pct: 91, resetsAt: 9e9 }, weekly: { pct: 40, resetsAt: 9e9 } };
  const queueText = ["▶ ws 12s npm run a-very-long-command-line-indeed", "⧗ 3 waiting: aaaa bbbb cccc"];
  const queueFor = (width: number) => queueText.map((q) => fit(q, width - 4));
  const footers = [
    undefined,
    EMPTY_PROMPT,
    { kind: FooterKind.Prompt, prompt: { text: "some long typed text that overflows the row", id: "123" } } as const,
    { kind: FooterKind.Busy, id: "a-long-id-1234567890" } as const,
    { kind: FooterKind.Error, message: "start failed: something went quite wrong here" } as const,
  ];

  for (const compact of [false, true]) {
    for (let width = 24; width <= 40; width++) {
      test(`${compact ? "compact" : "wide"} at ${width} columns`, () => {
        for (const current of [0, 1, 2, 3]) {
          for (const expanded of [false, true]) {
            const view: CardView = { compact, ...(expanded ? { expanded: { tab: list[current]!.tab, now: 10_000, tools: [{ label: "Bash:typecheck", at: 1000 }, { label: "mcp__server__a_long_tool_name", at: 2000 }] } } : {}) };
            for (const footer of footers) {
              const rows = renderSidebar(list, current, 0, 30, width, limits, 5e8, "v1.2.3-a-long-version", queueFor(width), footer, "", view);
              expect(rows).toHaveLength(30);
              for (const r of rows) expect(textWidth(plain(r))).toBe(width);
            }
          }
        }
      });
    }
  }
});
