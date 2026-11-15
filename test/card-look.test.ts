import { describe, expect, test } from "bun:test";
import { prHealthInput, pulseGlyph, pulses, timeTint, titleTone } from "../src/card-look";
import { healthOf } from "../src/pr-look";
import { type Entry, entryLines, Section } from "../src/sidebar";
import { animate } from "../src/sidebar-motion";
import { Motion } from "../src/config";
import { textWidth } from "../src/term";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const MIN = 60_000;
const entry = (over: Partial<Entry> = {}): Entry => ({ tab: "a", section: Section.Workspaces, glyph: "❓", label: "a", state: "waiting", ...over });

describe("timeTint", () => {
  test("a wait turns red after ten minutes", () => {
    expect(timeTint("waiting", 2 * MIN)).toBe("yellow");
    expect(timeTint("waiting", 10 * MIN)).toBe("red");
  });

  test("a long run warns amber then red", () => {
    expect(timeTint("busy", 5 * MIN)).toBeUndefined();
    expect(timeTint("busy", 10 * MIN)).toBe("yellow");
    expect(timeTint("busy", 30 * MIN)).toBe("red");
  });

  test("an old finish fades to grey; no state has no tint", () => {
    expect(timeTint("done", 2 * 60 * MIN)).toBe("grey");
    expect(timeTint(undefined, 99 * MIN)).toBeUndefined();
  });
});

describe("glyph pulse", () => {
  test("pairs are as wide as the glyph they replace", () => {
    for (const [state, glyph, unsaved] of [["waiting", "❓", false], ["bg", "⏳", false], ["end", "❌", true]] as const) {
      expect(pulses(state, glyph, unsaved)).toBe(true);
      expect(textWidth(pulseGlyph(state, glyph, unsaved, 0))).toBe(textWidth(glyph));
      expect(textWidth(pulseGlyph(state, glyph, unsaved, 500))).toBe(textWidth(glyph));
      expect(pulseGlyph(state, glyph, unsaved, 0)).not.toBe(pulseGlyph(state, glyph, unsaved, 500));
    }
  });

  test("an ended card with nothing unsaved, and a working card, stay still", () => {
    expect(pulses("end", "❌", false)).toBe(false);
    expect(pulses("busy", "🔄", false)).toBe(false);
  });

  test("animate pulses a waiting card, and Motion.Off leaves the list alone", () => {
    const list = [entry()];

    expect(animate(list, 500, Motion.Off)).toBe(list);
    expect(animate(list, 0, Motion.WhileActive)[0]?.glyph).toBe("❓");
    expect(animate(list, 500, Motion.WhileActive)[0]?.glyph).toBe("🔔");
  });

  test("a PR in conflict stamps the clock for its chip", () => {
    const list = [entry({ state: "busy", glyph: "🔄", prs: [{ number: 1, status: "conflict" }] })];

    expect(animate(list, 700, Motion.WhileActive)[0]?.at).toBe(700);
  });
});

describe("titleTone", () => {
  test("problem beats state; idle dims; working stays plain", () => {
    expect(titleTone("busy", true, true)).toBe("red");
    expect(titleTone("waiting", true, false)).toBe("yellow");
    expect(titleTone("done", true, false)).toBe("green");
    expect(titleTone("idle", true, false)).toBe("dim");
    expect(titleTone("busy", true, false)).toBeUndefined();
  });
});

describe("prHealthInput", () => {
  test("maps each PR status to the shared health", () => {
    expect(healthOf(prHealthInput("conflict"))).toBe("conflict");
    expect(healthOf(prHealthInput("failing"))).toBe("failing");
    expect(healthOf(prHealthInput("pending"))).toBe("waiting");
    expect(healthOf(prHealthInput("blocked"))).toBe("waiting");
    expect(healthOf(prHealthInput("mergeable"))).toBe("ready");
    expect(healthOf(prHealthInput("unknown"))).toBe("draft");
  });
});

describe("card rendering", () => {
  test("a long wait colours the elapsed time red inside a yellow line", () => {
    const e = entry({ since: Date.now() - 15 * MIN });
    const text = entryLines(e, 0, false, 40).join("\n");

    expect(text).toContain("\x1b[31m15m\x1b[0m");
    expect(plain(text)).toContain("needs input 15m");
  });

  test("PR chips share the status row and keep the card's width", () => {
    const e = entry({ state: "done", glyph: "✅", prs: [{ number: 2, status: "failing" }, { number: 3, status: "mergeable" }] });
    const lines = entryLines(e, 0, false, 40);

    expect(plain(lines[1] ?? "")).toContain("❌🟢");
    expect(lines.every((l) => textWidth(plain(l)) === 40)).toBe(true);
  });

  test("an idle card is dimmed, a waiting one coloured", () => {
    expect(entryLines(entry({ state: "idle", glyph: "💤" }), 0, false, 30)[0]).toContain("\x1b[2m");
    expect(entryLines(entry(), 0, false, 30)[0]).toContain("\x1b[33m");
  });
});
