import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordTurn, turnPath } from "../src/agent-state";
import { CONTEXT_STALE_MS, cachedRead, contextPath, gaugeText, readGauge, readReceipt, receiptText } from "../src/gauge";
import { type Entry, entryHeight, entryLines, Section, withReceipt } from "../src/sidebar";

let meta: string;
beforeEach(() => {
  meta = mkdtempSync(join(tmpdir(), "overbridge-gauge-"));
  mkdirSync(join(meta, "agent"));
  mkdirSync(join(meta, "context"));
});
afterEach(() => rmSync(meta, { recursive: true, force: true }));

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const writeContext = (ws: string, pct: number, at: number) => writeFileSync(contextPath(meta, ws), JSON.stringify({ at, pct }));

describe("recordTurn", () => {
  const turn = (ws: string, ...steps: [string, string?, string?][]) => {
    let now = 1000;
    for (const [event, tool, source] of steps) recordTurn(meta, ws, event, tool, source, (now += 1000));
  };
  const receipt = (ws: string) => readReceipt(ws, meta);

  test("a turn's duration, edits and errors become its receipt", () => {
    turn("w", ["UserPromptSubmit"], ["PostToolUse", "Bash"], ["PostToolUse", "Edit"], ["PostToolUse", "Write"], ["PostToolUseFailure", "Bash"], ["Stop"]);
    expect(receipt("w")).toEqual({ ms: 5000, edits: 2, errors: 1 });
  });

  test("no receipt until the turn stops, and a new prompt clears the old one", () => {
    turn("w", ["UserPromptSubmit"], ["PostToolUse", "Edit"]);
    expect(receipt("w")).toBeUndefined();
    turn("w", ["Stop"]);
    expect(receipt("w")?.edits).toBe(1);
    turn("w", ["UserPromptSubmit"]);
    expect(receipt("w")).toBeUndefined();
  });

  test("an ordinary tool call writes nothing", () => {
    recordTurn(meta, "w", "PostToolUse", "Bash", undefined);
    recordTurn(meta, "w", "PreToolUse", "Edit", undefined);
    expect(() => readFileSyncOrNull(turnPath(meta, "w"))).not.toThrow();
    expect(readFileSyncOrNull(turnPath(meta, "w"))).toBeNull();
  });

  test("a fresh session resets, a resume or compact keeps", () => {
    turn("w", ["UserPromptSubmit"], ["Stop"], ["SessionStart", undefined, "resume"]);
    expect(receipt("w")).toBeDefined();
    turn("w", ["SessionStart", undefined, "clear"]);
    expect(receipt("w")).toBeUndefined();
  });

  test("a compaction survives the next prompt", () => {
    writeContext("w", 40, Date.now());
    recordTurn(meta, "w", "PreCompact", undefined, undefined, Date.now());
    recordTurn(meta, "w", "UserPromptSubmit", undefined, undefined, Date.now());
    expect(readGauge("w", Date.now(), meta)?.compacted).toBe(true);
  });
});

function readFileSyncOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

describe("readGauge", () => {
  test("reads the percent, clamped", () => {
    writeContext("w", 62, 5000);
    expect(readGauge("w", 5000, meta)).toEqual({ pct: 62, compacted: false });
    writeContext("w", 140, 5000);
    expect(readGauge("w", 5000, meta)?.pct).toBe(100);
  });

  test("a stale, missing or malformed reading is none", () => {
    writeContext("w", 62, 5000);
    expect(readGauge("w", 5000 + CONTEXT_STALE_MS + 1, meta)).toBeUndefined();
    expect(readGauge("none", 5000, meta)).toBeUndefined();
    writeFileSync(contextPath(meta, "bad"), "{nope");
    expect(readGauge("bad", 5000, meta)).toBeUndefined();
    writeFileSync(contextPath(meta, "bad"), '{"pct":"x"}');
    expect(readGauge("bad", 5000, meta)).toBeUndefined();
  });
});

describe("cachedRead", () => {
  test("parses again only when the mtime changes", () => {
    const file = join(meta, "c.json");
    writeFileSync(file, "1");
    utimesSync(file, 100, 100);
    let parses = 0;
    const parse = (raw: unknown) => (parses++, raw as number);
    expect(cachedRead(file, parse)).toBe(1);
    expect(cachedRead(file, parse)).toBe(1);
    expect(parses).toBe(1);
    writeFileSync(file, "2");
    utimesSync(file, 200, 200);
    expect(cachedRead(file, parse)).toBe(2);
    expect(parses).toBe(2);
  });

  test("a removed file reads as none", () => {
    const file = join(meta, "c.json");
    writeFileSync(file, "1");
    expect(cachedRead(file, (r) => r as number)).toBe(1);
    rmSync(file);
    expect(cachedRead(file, (r) => r as number)).toBeUndefined();
  });
});

describe("text", () => {
  test("gauge fills in fifths and marks a compaction", () => {
    expect(gaugeText({ pct: 62, compacted: false })).toBe("▕███░░▏62%");
    expect(gaugeText({ pct: 0, compacted: false })).toBe("▕░░░░░▏0%");
    expect(gaugeText({ pct: 100, compacted: true })).toBe("▕█████▏100% ↻");
  });

  test("receipt leaves out zero counts and pluralises", () => {
    expect(receiptText({ ms: 134_000, edits: 3, errors: 1 })).toBe("last turn 2m14s · 3 edits · 1 error");
    expect(receiptText({ ms: 40_000, edits: 1, errors: 0 })).toBe("last turn 40s · 1 edit");
    expect(receiptText({ ms: 40_000, edits: 0, errors: 0 })).toBe("last turn 40s");
  });
});

describe("card rendering", () => {
  const card = (over: Partial<Entry> = {}): Entry => ({ tab: "a", section: Section.Workspaces, glyph: "●", label: "a", ...over });

  test("a busy card carries the gauge after its status", () => {
    const [, sub] = entryLines(card({ state: "busy", gauge: { pct: 62, compacted: false } }), 0, false, 40);
    expect(plain(sub!)).toMatch(/^ +working +▕███░░▏62%$/);
  });

  test("the gauge stays at the right edge beside a task suffix", () => {
    const [, sub] = entryLines(card({ state: "busy", task: "implement a rather long phase name", gauge: { pct: 62, compacted: false } }), 0, false, 40);
    expect(plain(sub!)).toHaveLength(40);
    expect(plain(sub!).endsWith("▕███░░▏62%")).toBe(true);
  });

  test("another status keeps the line", () => {
    const [, sub] = entryLines(card({ state: "busy", gauge: { pct: 62, compacted: false }, unsaved: true }), 0, false, 40);
    expect(plain(sub!)).not.toContain("▕");
  });

  test("a receipt adds one row and its height", () => {
    const e = card({ state: "done", receipt: { ms: 5000, edits: 2, errors: 0 } });
    const rows = entryLines(e, 0, true, 40);
    expect(rows).toHaveLength(entryHeight(e, 0, 40));
    expect(plain(rows.at(-1)!).trim()).toBe("last turn 5s · 2 edits");
  });

  test("withReceipt reads only the selected, resting, readable card", () => {
    const asked: string[] = [];
    const read = (ws: string) => (asked.push(ws), { ms: 1, edits: 0, errors: 0 });
    const out = withReceipt([card({ tab: "a", state: "done" }), card({ tab: "b", state: "done" }), card({ tab: "s", state: "busy" }), card({ tab: "f", fault: "x" })], "b", read);
    expect(asked).toEqual(["b"]);
    expect(out.map((e) => !!e.receipt)).toEqual([false, true, false, false]);
    expect(withReceipt([card({ tab: "s", state: "busy" })], "s", read)[0]!.receipt).toBeUndefined();
  });
});
