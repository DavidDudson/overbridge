import { describe, expect, test } from "bun:test";
import { AppStatus } from "../src/apps";
import type { AppSpec } from "../src/project-config";
import { type Entry, renderSidebar } from "../src/sidebar";
import { ENTER_SCREEN, frame, LEAVE_SCREEN } from "../src/term";
import { cell, layoutTop, paintTop, type TopApp, type TopSnapshot } from "../src/top";
import { Screen } from "./helpers/screen";

const entry = (ws: string, glyph: string, label = ws): Entry => ({ ws, glyph, label });

describe("virtual screen", () => {
  test("addresses cells, clears, and tracks styles", () => {
    const s = new Screen(10, 3).write("\x1b[2;3Hab\x1b[7mcd\x1b[0me\x1b[1;1Hx");
    expect(s.line(0)).toBe("x");
    expect(s.line(1)).toBe("  abcde");
    expect(s.inverseText(1)).toBe("cd");
    s.write("\x1b[2J");
    expect(s.lines()).toEqual([]);
  });

  test("ignores mode switches and clips instead of wrapping", () => {
    const s = new Screen(4, 2).write(`${ENTER_SCREEN}\x1b[1;1Habcdefgh${LEAVE_SCREEN}`);
    expect(s.lines()).toEqual(["abcd"]);
  });
});

describe("sidebar on screen", () => {
  const list: Entry[] = [
    { ...entry("ws1", "●", "12 Add dark mode"), state: "busy" },
    { ...entry("ws2", "?"), state: "waiting" },
    entry("ws3", "·"),
    { ...entry("ws4", "✔", "7 Fix the login redirect loop"), state: "done" },
  ];
  const draw = (current: number, offset: number, height: number, width: number, items = list) =>
    new Screen(width, height).write(frame(renderSidebar(items, current, offset, height, width, undefined, 0), height, width));

  test("a rounded frame with a padded two-line card per workspace; the current card is inverse", () => {
    const s = draw(1, 0, 16, 34);
    expect(s.line(0)).toMatch(/^╭─ Workspaces ─+╮$/);
    expect(s.line(1)).toMatch(/^│ ⌥1 ● 12 Add dark mode +│$/);
    expect(s.line(2)).toMatch(/^│ +working +│$/);
    expect(s.line(3)).toMatch(/^│ ⌥2 \? ws2 +│$/);
    expect(s.line(4)).toMatch(/^│ +needs your input +│$/);
    expect(s.inverseRows()).toEqual([3, 4]);
    expect(s.line(15)).toMatch(/^╰─+╯$/);
  });

  test("long labels wrap under their text inside the padding, never over the border", () => {
    const s = draw(3, 3, 20, 24);
    expect(s.line(1)).toBe("│ ⌥4 ✔ 7 Fix the login │");
    expect(s.line(2)).toBe("│      redirect loop   │");
    expect(s.line(3)).toMatch(/^│ +finished +│$/);
    for (let y = 0; y < 20; y++) expect(s.line(y).length).toBeLessThanOrEqual(24);
  });

  test("a scrolled window starts at the offset", () => {
    const s = draw(3, 2, 10, 30);
    expect(s.line(1)).toContain("⌥3 · ws3");
    expect(s.line(3)).toContain("⌥4 ✔");
  });

  test("a shorter list leaves no cards behind from a longer one", () => {
    const s = draw(0, 0, 16, 30);
    s.write(frame(renderSidebar(list.slice(0, 1), 0, 0, 16, 30, undefined, 0), 16, 30));
    expect(s.lines().join("\n")).not.toContain("ws2");
  });
});

describe("top panel on screen", () => {
  const spec = (id: string): AppSpec => ({ id, label: id, dir: ".", start: "x", ports: [], open: false, when: "always" });
  const app = (id: string, status: AppStatus, port?: number): TopApp => ({
    repo: "r",
    spec: spec(id),
    repoDir: "/w/r",
    status,
    available: true,
    ...(port === undefined ? {} : { port }),
  });
  const snap: TopSnapshot = {
    ws: "w1",
    dir: "/w/w1",
    headline: "12 Add dark mode",
    title: "Add dark mode",
    links: [{ label: "12", url: "u" }, { label: "PR #3", url: "u3" }],
    ide: "zed",
    apps: [app("web", AppStatus.Running, 3000), app("db", AppStatus.Stopped)],
    message: "refresh failed",
  };
  const draw = (width: number, cursor: number, height = 8) => {
    const f = layoutTop(snap, width, height);
    return { f, s: new Screen(width, height).write(paintTop(f, cursor)) };
  };

  test("a frame titled with the task name, one row of buttons, the message in the bottom border", () => {
    const { f, s } = draw(160, 0, 3);
    expect(f.rows).toHaveLength(3);
    expect(s.line(0)).toMatch(/^╭─ Add dark mode ─+╮$/);
    expect(s.line(1)).toMatch(/^│ \[ 📋 12.*\] +│$/);
    expect(s.line(2)).toMatch(/^╰─ refresh failed ─+╯$/);
    expect(new Set(f.placed.map((p) => p.row))).toEqual(new Set([1]));
    expect(f.placed.map((p) => p.button.label)).toEqual(["📋 12", "📋 PR #3", "🟢 web :3000", "⚫ db", "📝 zed", "🤖 claude", "💻 terminal", "🔀 diff"]);
    for (const p of f.placed) expect(s.line(1)).toContain(cell(p.button));
  });

  test("the cursor button is the only inverse text", () => {
    const { s } = draw(160, 2);
    expect(s.inverseRows()).toEqual([1]);
    expect(s.inverseText(1)).toBe("[ 🟢 web :3000 · 1 ]");
  });

  test("the title is bold", () => {
    const { s } = draw(160, 0, 3);
    expect(s.cells[0]![3]!.bold).toBe(true);
    expect(s.cells[0]![0]!.bold).toBe(false);
  });

  test("a taller pane pads the frame so the bottom border sits on the last row", () => {
    const { s } = draw(160, 0, 6);
    expect(s.line(5)).toMatch(/^╰─ refresh failed ─+╯$/);
    expect(s.line(4)).toMatch(/^│ +│$/);
  });

  test("narrow panes wrap buttons inside the frame without clipping them", () => {
    const { f, s } = draw(24, 0, 20);
    const rows = s.lines();
    expect(rows[0]).toMatch(/^╭─ Add dark mode ─+╮$/);
    expect(rows.at(-1)).toMatch(/^╰─ refresh failed ─+╯$/);
    expect(rows.length).toBeGreaterThan(3);
    for (const p of f.placed) expect(s.line(p.row)).toContain(cell(p.button));
  });

  test("PR rows sit above a divider; the launchers draw under it", () => {
    const pr = { repo: "api", number: 7, title: "feat: x", draft: false, dir: "/w/w1/api", stack: [] };
    const f = layoutTop({ ...snap, links: [{ label: "PR #7", url: "u7", status: "mergeable", pr }] }, 140, 8);
    const s = new Screen(140, 8).write(paintTop(f, 0));
    expect(s.line(1)).toContain("api #7");
    expect(s.line(2)).toMatch(/^│ ── actions ─+ *│$/);
    expect(s.line(3)).toContain("web :3000");
    expect(s.line(3)).toContain("diff");
    expect(s.line(1)).not.toContain("diff");
  });

  test("resizing is a redraw: wide to narrow to wide gives the same screen as drawing wide", () => {
    const wide = draw(80, 0).s.lines();
    const s = new Screen(80, 8);
    s.write(paintTop(layoutTop(snap, 24, 8), 0));
    s.write(paintTop(layoutTop(snap, 80, 8), 0));
    expect(s.lines()).toEqual(wide);
  });
});
