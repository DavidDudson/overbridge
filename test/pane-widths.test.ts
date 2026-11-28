import { describe, expect, test } from "bun:test";
import { type PaneBox, planWidths, sidebarWidth } from "../src/pane-widths";

const box = (id: string, title: string, left: number, width: number, windowWidth = 200, window = "@1"): PaneBox => ({ id, window, windowWidth, title, left, width });

describe("planWidths", () => {
  test("a quarter for the sidebar, the rest split evenly between Claude and the diff", () => {
    // after a window resize tmux left the sidebar at 80, Claude at 88 and the diff at 30
    const steps = planWidths([box("%1", "sidebar", 0, 80), box("%2", "top", 81, 119), box("%3", "w · claude", 81, 88), box("%4", "w · diff", 170, 30)]);
    expect(steps).toEqual([
      { id: "%1", width: 50 },
      { id: "%3", width: 74 },
    ]);
    // 50 + 1 border + 74 + 1 border + 74 = 200: the diff takes what Claude leaves
  });

  test("nothing to do when the widths already hold", () => {
    expect(planWidths([box("%1", "sidebar", 0, 50), box("%3", "w · claude", 51, 74), box("%4", "w · diff", 126, 74)])).toEqual([]);
  });

  test("with no diff beside Claude only the sidebar is set", () => {
    expect(planWidths([box("%1", "sidebar", 0, 10), box("%3", "w · claude", 11, 188)])).toEqual([{ id: "%1", width: 50 }]);
    // a terminal pane under the diff is not a column of its own
    expect(planWidths([box("%1", "sidebar", 0, 50), box("%3", "w · claude", 51, 74), box("%4", "w · diff", 126, 74), box("%5", "w · terminal", 126, 74)])).toEqual([]);
  });

  test("each window is planned by its own width, and one with no sidebar is left alone", () => {
    const steps = planWidths([box("%1", "sidebar", 0, 10, 100, "@1"), box("%2", "sidebar", 0, 10, 300, "@2"), box("%3", "x", 0, 300, 300, "@3")]);
    expect(steps).toEqual([
      { id: "%1", width: 25 },
      { id: "%2", width: 75 },
    ]);
  });

  test("an odd remainder gives Claude the smaller half", () => {
    // 201 columns: sidebar 50, content 149
    expect(planWidths([box("%1", "sidebar", 0, 50, 201), box("%3", "w · claude", 51, 90, 201), box("%4", "w · diff", 142, 59, 201)])).toEqual([{ id: "%3", width: 74 }]);
  });

  test("a diff that drifted alone still gets Claude's step", () => {
    expect(planWidths([box("%1", "sidebar", 0, 50), box("%3", "w · claude", 51, 74), box("%4", "w · diff", 126, 40)])).toEqual([{ id: "%3", width: 74 }]);
  });

  test("a diff not to the right of Claude, or a sidebar off column 0, is left alone", () => {
    expect(planWidths([box("%1", "sidebar", 0, 50), box("%3", "w · claude", 51, 30), box("%4", "w · diff", 51, 30)])).toEqual([]);
    expect(planWidths([box("%1", "sidebar", 0, 50), box("%3", "w · claude", 126, 30), box("%4", "w · diff", 51, 30)])).toEqual([]);
    expect(planWidths([box("%1", "sidebar", 5, 10)])).toEqual([]);
  });

  test("Claude is set whenever the sidebar moves, even if its measured width looks right", () => {
    expect(planWidths([box("%1", "sidebar", 0, 80), box("%3", "w · claude", 81, 74), box("%4", "w · diff", 156, 44)])).toEqual([
      { id: "%1", width: 50 },
      { id: "%3", width: 74 },
    ]);
  });

  test("a window too narrow to split plans no negative widths", () => {
    expect(planWidths([box("%1", "sidebar", 0, 2, 4), box("%3", "w · claude", 3, 1, 4), box("%4", "w · diff", 5, 1, 4)])).toEqual([{ id: "%1", width: 1 }]);
  });

  test("the sidebar share matches tmux's own percentage", () => {
    expect(sidebarWidth(200)).toBe(50);
    expect(sidebarWidth(81)).toBe(20);
  });
});
