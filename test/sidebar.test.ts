import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { zellijMux } from "../src/mux";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentStateFile, glyphFor, readAgentState, UNKNOWN_GLYPH } from "../src/agent-state";
import { sidebarWidth } from "../src/config";
import { layoutKdl, SIDEBAR_WIDTH } from "../src/layout";
import { metaDir, reposFile } from "../src/paths";
import { bodyRowsFor, clampScroll, commitDigit, EMPTY_PROMPT, type Entry, entryAt, entryHeight, entryLines, type Finished, type Footer, FooterKind, footerRow, legend, LEGEND_FOOTER, parseStart, pinnedCount, pinnedRowsFor, promptInput, queueRows, PromptStepKind, renderSidebar, runStart, scrollFor, Section, sidebarLabel, StartPlanKind, stepFor, stripConventional, switchTab, targetFor, travelTab, visitTab, wrapText } from "../src/sidebar";
import { readHistory, Travel, writeHistory } from "../src/sidebar-history";
import { type Input, textWidth } from "../src/term";

const entry = (tab: string, glyph = "○", label = tab, section: Section = Section.Workspaces): Entry => ({ tab, section, glyph, label });
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

  test("the first nine entries show their Alt key, the rest their two-digit number", () => {
    expect(entryLines(entry("x"), 8, false, 10)[0]!.startsWith("⌥9 ")).toBe(true);
    expect(entryLines(entry("x"), 9, false, 10)[0]!.startsWith("10 ")).toBe(true);
    expect(entryLines(entry("x"), 11, false, 10)[0]!.startsWith("12 ")).toBe(true);
  });

  test("a frame fits the height and width exactly, with a card per entry and the limits inside", () => {
    const rows = renderSidebar(list, 0, 0, 20, 30, undefined, 0);
    expect(rows).toHaveLength(20);
    for (const r of rows) expect(textWidth(r.replace(/\x1b\[[0-9;]*m/g, ""))).toBe(30);
    expect(rows[0]).toContain("Workspaces");
    expect(rows.at(-1)).toContain("╰");
    expect(rows.join("\n")).toContain("Hourly");
  });

  test("the version sits in the bottom-left corner, and the border stays plain without one", () => {
    const plain = (r: string) => r.replace(/\x1b\[[0-9;]*m/g, "");
    const last = plain(renderSidebar(list, 0, 0, 20, 30, undefined, 0, "v1.2.3").at(-1)!);
    expect(last.startsWith("╰─ v1.2.3 ─")).toBe(true);
    expect(textWidth(last)).toBe(30);
    expect(plain(renderSidebar(list, 0, 0, 20, 30, undefined, 0).at(-1)!)).toBe(`╰${"─".repeat(28)}╯`);
  });

  test("a window starts at the offset", () => {
    const rows = renderSidebar(list, 3, 3, 12, 30, undefined, 0);
    expect(rows[1]).toContain("⌥4 ");
  });
});

describe("orchestration frame", () => {
  const root = entry("@root", "○", "overbridge root", Section.Orchestration);
  const withRoot = [root, ...list];
  const plain = (rows: string[]) => rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""));

  test("draws above Workspaces, takes ⌥1, and the workspace window scrolls under it", () => {
    const rows = plain(renderSidebar(withRoot, 0, 2, 20, 30, undefined, 0));
    expect(rows).toHaveLength(20);
    expect(rows[0]).toContain("Orchestration");
    expect(rows[1]).toContain("⌥1 ○ overbridge root");
    expect(rows[3]).toMatch(/^╰─+╯$/);
    expect(rows[4]).toContain("Workspaces");
    expect(rows[5]).toContain("⌥4 ○ w3");
  });

  test("the current entry is inverse in either frame", () => {
    expect(renderSidebar(withRoot, 0, 0, 20, 30, undefined, 0)[1]).toContain("\x1b[7m");
    expect(renderSidebar(withRoot, 1, 0, 20, 30, undefined, 0)[1]).not.toContain("\x1b[7m");
    expect(renderSidebar(withRoot, 1, 0, 20, 30, undefined, 0)[5]).toContain("\x1b[7m");
  });

  test("no orchestration entries, no frame", () => {
    expect(plain(renderSidebar(list, 0, 0, 20, 30, undefined, 0))[0]).toContain("Workspaces");
  });

  test("a click picks a pinned card, or a workspace card through the offset; borders pick nothing", () => {
    const h = Array(withRoot.length).fill(2);
    const rows = bodyRowsFor(20, pinnedRowsFor(h, 1));
    expect(rows).toBe(10);
    const click = (row: number, current = 3) => targetFor({ kind: "click", col: 3, row }, current, 2, h, rows, 1);
    expect(click(0)).toBeUndefined();
    expect(click(1)).toBe(0);
    expect(click(2)).toBe(0);
    expect(click(3)).toBeUndefined();
    expect(click(4)).toBeUndefined();
    expect(click(5, 0)).toBe(3);
    expect(click(7, 0)).toBe(4);
  });

  test("keys step and jump across both frames", () => {
    const h = Array(withRoot.length).fill(2);
    expect(targetFor(key("up"), 1, 0, h, 10, 1)).toBe(0);
    expect(targetFor(key("down"), 0, 0, h, 10, 1)).toBe(1);
    expect(stepFor(key("1"), 4, 0, h, 10, 1)).toEqual({ pending: "1" });
    expect(commitDigit("1", withRoot, withRoot[4]!.tab, withRoot[4]!.tab)).toBe(0);
  });

  test("pinnedCount counts the orchestration entries", () => {
    expect(pinnedCount(withRoot)).toBe(1);
    expect(pinnedCount(list)).toBe(0);
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

  test("a click picks the row under it, through the scroll offset", () => {
    expect(targetFor({ kind: "click", col: 3, row: 3 }, 0, 4, h, 20)).toBe(5);
    expect(targetFor({ kind: "click", col: 3, row: 40 }, 0, 0, h, 20)).toBeUndefined();
  });

  test("other keys do nothing", () => {
    expect(targetFor(key("x"), 0, 0, h, 20)).toBeUndefined();
  });
});

describe("stepFor", () => {
  const h14 = Array(14).fill(2);
  const h4 = Array(4).fill(2);

  test("a digit no two-digit tab starts with jumps at once; out of range or the current tab does nothing", () => {
    expect(stepFor(key("5"), 0, 0, h14, 20)).toEqual({ target: 4, pending: "" });
    expect(stepFor(key("9"), 0, 0, h4, 20).target).toBeUndefined();
    expect(stepFor(key("1"), 0, 0, h4, 20)).toEqual({ target: undefined, pending: "" });
    expect(stepFor(key("0"), 0, 0, h14, 20)).toEqual({ pending: "" });
  });

  test("a digit that could start a two-digit tab is held", () => {
    expect(stepFor(key("1"), 3, 0, Array(10).fill(2), 20)).toEqual({ pending: "1" });
    expect(stepFor(key("1"), 3, 0, Array(9).fill(2), 20)).toEqual({ target: 0, pending: "" });
  });

  test("a second digit picks the two-digit tab, or the held digit's own tab past the end", () => {
    expect(stepFor(key("2"), 0, 0, h14, 20, 0, "1")).toEqual({ target: 11, pending: "" });
    expect(stepFor(key("0"), 0, 0, h14, 20, 0, "1")).toEqual({ target: 9, pending: "" });
    expect(stepFor(key("7"), 3, 0, h14, 20, 0, "1")).toEqual({ target: 0, pending: "" });
  });

  test("any other input drops the held digit", () => {
    expect(stepFor(key("down"), 0, 0, h14, 20, 0, "1")).toEqual({ target: 1, pending: "" });
    expect(stepFor(key("x"), 0, 0, h14, 20, 0, "1").pending).toBe("");
  });

  test("←/h and →/l travel the history", () => {
    expect(stepFor(key("left"), 0, 0, h14, 20, 0, "1")).toEqual({ travel: Travel.Back, pending: "" });
    expect(stepFor(key("h"), 0, 0, h14, 20).travel).toBe(Travel.Back);
    expect(stepFor(key("right"), 0, 0, h14, 20).travel).toBe(Travel.Forward);
    expect(stepFor(key("l"), 0, 0, h14, 20).travel).toBe(Travel.Forward);
  });
});

describe("commitDigit", () => {
  test("goes to the held digit's tab while this tab has focus", () => {
    expect(commitDigit("1", list, "w3", "w3")).toBe(0);
  });

  test("drops the digit when another tab has focus, or nothing is held", () => {
    expect(commitDigit("1", list, "w3", "w5")).toBeUndefined();
    expect(commitDigit("1", list, "w3", undefined)).toBeUndefined();
    expect(commitDigit("", list, "w3", "w3")).toBeUndefined();
  });
});

describe("legend", () => {
  test("shows the range the digits reach", () => {
    expect(legend(14)).toStartWith("1-14 go");
    expect(legend(1)).toStartWith("1 go");
    expect(legend(0)).toStartWith("←→");
  });

  test("shows the held digit while it waits", () => {
    expect(legend(14, "1")).toBe("1…");
    const rows = renderSidebar(list, 0, 0, 20, 40, undefined, 0, "", [], LEGEND_FOOTER, "1");
    expect(rows.join("\n")).toContain("1…");
    expect(renderSidebar(list, 0, 0, 20, 40, undefined, 0).join("\n")).toContain("1-12 go");
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
    const record = zellijMux((c) => { calls.push(c); return { ok: true, stdout: "" }; });
    expect(switchTab("w2", record)).toBe(true);
    expect(calls).toEqual([["zellij", "action", "go-to-tab-name", "w2"]]);

    mkdirSync(join(metaDir(), "sidebars"), { recursive: true });
    writeFileSync(join(metaDir(), "sidebars", "w2"), "7\n");
    calls.length = 0;
    switchTab("w2", record);
    expect(calls).toEqual([
      ["zellij", "action", "go-to-tab-name", "w2"],
      ["zellij", "action", "focus-pane-id", "terminal_7"],
    ]);
  });

  test("fails only when the tab switch fails, not when its sidebar already has focus", () => {
    mkdirSync(join(metaDir(), "sidebars"), { recursive: true });
    writeFileSync(join(metaDir(), "sidebars", "w2"), "7\n");
    expect(switchTab("w2", zellijMux((c) => ({ ok: c[2] !== "focus-pane-id", stdout: "" })))).toBe(true);
    expect(switchTab("w2", zellijMux(() => ({ ok: false, stdout: "" })))).toBe(false);
  });
});

describe("switching with history", () => {
  const ok = zellijMux(() => ({ ok: true, stdout: "" }));
  const fail = zellijMux(() => ({ ok: false, stdout: "" }));

  test("a visit records the tab left, and ← then → walk back and forward", () => {
    expect(visitTab("w1", "w2", ok)).toBe(true);
    expect(visitTab("w2", "w3", ok)).toBe(true);
    expect(readHistory()).toEqual({ back: ["w1", "w2"], forward: [] });
    expect(travelTab("w3", Travel.Back, list, ok)).toBe(true);
    expect(readHistory()).toEqual({ back: ["w1"], forward: ["w3"] });
    expect(travelTab("w2", Travel.Forward, list, ok)).toBe(true);
    expect(readHistory()).toEqual({ back: ["w1", "w2"], forward: [] });
  });

  test("a failed switch leaves the history as it was", () => {
    writeHistory({ back: ["w1"], forward: [] });
    expect(visitTab("w2", "w3", fail)).toBe(false);
    expect(travelTab("w2", Travel.Back, list, fail)).toBe(false);
    expect(readHistory()).toEqual({ back: ["w1"], forward: [] });
  });

  test("travel with nowhere to go does not switch", () => {
    const calls: string[][] = [];
    expect(travelTab("w1", Travel.Back, list, zellijMux((c) => { calls.push(c); return { ok: true, stdout: "" }; }))).toBe(false);
    expect(calls).toEqual([]);
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

describe("stacked PRs on a card", () => {
  const stacked: Entry = { ...entry("a", "●", "12 Add dark mode"), state: "busy", stacks: [{ prs: [11, 12, 13], current: 12 }] };

  test("a three-layer stack is one line, bottom to top, the claimed layer in brackets", () => {
    const rows = entryLines(stacked, 0, false, 30);
    expect(rows).toHaveLength(entryHeight(stacked, 0, 30));
    expect(rows.at(-1)).toContain("stack 11·[12]·13");
    expect(entryLines(entry("a"), 0, false, 30)).toHaveLength(entryHeight(entry("a"), 0, 30));
    expect(entryHeight(stacked, 0, 30)).toBe(entryHeight(entry("a", "●", "12 Add dark mode"), 0, 30) + 1);
  });

  test("the selected card keeps the stack line inside its inverse block", () => {
    const rows = entryLines(stacked, 0, true, 30);
    expect(rows.every((r) => r.startsWith("\x1b[7m"))).toBe(true);
  });
});

describe("new workspace prompt", () => {
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const type = (text: string, start = { text: "" }) =>
    [...text].reduce((p, ch) => {
      const step = promptInput(p, key(ch));
      if (step.kind !== PromptStepKind.Edit) throw new Error(`unexpected ${step.kind} on '${ch}'`);
      return step.prompt;
    }, start);

  test("the legend names the s key and shows in the footer by default", () => {
    expect(legend(12)).toContain("s new ws");
    const rows = renderSidebar(list, 0, 0, 20, 60, undefined, 0);
    expect(strip(rows.at(-2)!)).toContain("s new ws");
  });

  test("printable keys type, including sidebar keys; backspace deletes one character", () => {
    expect(type("q j 9").text).toBe("q j 9");
    const step = promptInput({ text: "ab" }, key("\x7f"));
    expect(step).toEqual({ kind: PromptStepKind.Edit, prompt: { text: "a" } });
    expect(promptInput({ text: "" }, key("\b"))).toEqual({ kind: PromptStepKind.Edit, prompt: { text: "" } });
  });

  test("Esc and Ctrl-C cancel, Enter submits, arrows and clicks do nothing", () => {
    const p = { text: "overbridge 79" };
    expect(promptInput(p, key("escape"))).toEqual({ kind: PromptStepKind.Cancel });
    expect(promptInput(p, key("ctrl-c"))).toEqual({ kind: PromptStepKind.Cancel });
    expect(promptInput(p, key("enter"))).toEqual({ kind: PromptStepKind.Submit, prompt: p });
    expect(promptInput(p, key("up"))).toEqual({ kind: PromptStepKind.Edit, prompt: p });
    expect(promptInput(p, { kind: "click", col: 0, row: 0 })).toEqual({ kind: PromptStepKind.Edit, prompt: p });
  });

  test("the footer shows the prompt, keeping the end of long text visible", () => {
    expect(strip(footerRow(EMPTY_PROMPT, 20)).trimEnd()).toBe("new ws: █");
    const long: Footer = { kind: FooterKind.Prompt, prompt: { text: "web-monorepo ENG-12345" } };
    expect(strip(footerRow(long, 16))).toBe("…repo ENG-12345█");
    expect(strip(footerRow({ kind: FooterKind.Prompt, prompt: { text: "", id: "79" } }, 30)).trimEnd()).toBe("repo for 79: █");
  });

  test("busy and error footers", () => {
    expect(strip(footerRow({ kind: FooterKind.Busy, id: "79" }, 20)).trimEnd()).toBe("starting 79…");
    const err = footerRow({ kind: FooterKind.Error, message: "79: not found in github" }, 30);
    expect(err).toContain("\x1b[31m");
    expect(strip(err).trimEnd()).toBe("79: not found in github");
  });

  test("<repo> <id> runs as typed", () => {
    expect(parseStart({ text: " web-monorepo  ENG-123 " }, ["overbridge"])).toEqual({ kind: StartPlanKind.Run, repo: "web-monorepo", id: "ENG-123" });
  });

  test("an id alone uses the one repo the workspace holds", () => {
    expect(parseStart({ text: "79" }, ["overbridge"])).toEqual({ kind: StartPlanKind.Run, repo: "overbridge", id: "79" });
  });

  test("an id alone asks for the repo when the workspace holds none or several, then runs with the answer", () => {
    expect(parseStart({ text: "79" }, [])).toEqual({ kind: StartPlanKind.AskRepo, id: "79" });
    expect(parseStart({ text: "79" }, ["a", "b"])).toEqual({ kind: StartPlanKind.AskRepo, id: "79" });
    expect(parseStart({ text: "overbridge", id: "79" }, ["a", "b"])).toEqual({ kind: StartPlanKind.Run, repo: "overbridge", id: "79" });
  });

  test("empty or extra words are invalid, with an example", () => {
    expect(parseStart({ text: "  " }, ["overbridge"])).toEqual({ kind: StartPlanKind.Invalid, message: "type <repo> <id> or <id>, such as overbridge 123" });
    expect(parseStart({ text: "a b c" }, []).kind).toBe(StartPlanKind.Invalid);
    expect(parseStart({ text: "", id: "79" }, []).kind).toBe(StartPlanKind.Invalid);
    expect(parseStart({ text: "a b", id: "79" }, []).kind).toBe(StartPlanKind.Invalid);
  });
});

describe("runStart", () => {
  const spawner = (result: Finished) => {
    const calls: string[][] = [];
    return { calls, spawn: async (cmd: string[]) => (calls.push(cmd), result) };
  };

  test("runs overbridge start with the repo and id, and returns to the legend on success", async () => {
    const s = spawner({ code: 0, stderr: "ENG-1 already exists; switching to it\n" });
    expect(await runStart("web-monorepo", "ENG-1", s.spawn)).toEqual({ kind: FooterKind.Legend });
    expect(s.calls[0]!.slice(-3)).toEqual(["start", "web-monorepo", "ENG-1"]);
  });

  test("a failed start shows the last stderr line without the CLI prefix", async () => {
    const s = spawner({ code: 1, stderr: "fetching\noverbridge: 79: not found in github\n\n" });
    expect(await runStart("overbridge", "79", s.spawn)).toEqual({ kind: FooterKind.Error, message: "79: not found in github" });
  });

  test("a failure with no stderr names the command and exit code", async () => {
    expect(await runStart("x", "1", spawner({ code: 2, stderr: "" }).spawn)).toEqual({ kind: FooterKind.Error, message: "overbridge start x 1 failed with exit code 2" });
  });

  test("a spawn that throws becomes an error footer, not a crash", async () => {
    const footer = await runStart("x", "1", async () => {
      throw new Error("ENOENT");
    });
    expect(footer).toEqual({ kind: FooterKind.Error, message: "could not run overbridge start: ENOENT" });
  });
});

describe("check queue rows", () => {
  const plain = (rows: string[]) => rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
  const t = (ws: string, extra = {}) => ({ pid: 1, ws, repo: "app", command: "just test", queuedAtMs: 0, ...extra });

  test("nothing when the queue is empty", () => {
    expect(queueRows({ running: [], waiting: [] }, 30, 0)).toEqual([]);
  });

  test("the running command with its time, then who waits", () => {
    const rows = queueRows({ running: [t("67", { runPid: 9, runningSinceMs: 0 })], waiting: [t("68"), t("70")] }, 40, 83_000);
    expect(plain(rows)).toEqual(["▶ 67 1m23s just test", "⧗ 2 waiting: 68 70"]);
  });

  test("a row for each running command", () => {
    const running = [t("67", { runPid: 9, runningSinceMs: 0 }), t("68", { runPid: 10, runningSinceMs: 60_000, command: "just lint" })];
    expect(plain(queueRows({ running, waiting: [t("70")] }, 40, 83_000))).toEqual(["▶ 67 1m23s just test", "▶ 68 23s just lint", "⧗ 1 waiting: 70"]);
  });

  test("the rows take space from the list, so the frame keeps its height", () => {
    const queue = queueRows({ running: [t("67", { runPid: 9, runningSinceMs: 0 })], waiting: [t("68")] }, 26, 5_000);
    const rows = renderSidebar(list, 0, 0, 20, 30, undefined, 0, "", queue);
    expect(rows).toHaveLength(20);
    expect(rows.join("\n")).toContain("▶ 67 5s just test");
    expect(rows.findIndex((r) => r.includes("▶"))).toBeGreaterThan(rows.findIndex((r) => r.includes("├")));
  });
});
