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

  test("the sidebar share matches tmux's own percentage", () => {
    expect(sidebarWidth(200)).toBe(50);
    expect(sidebarWidth(81)).toBe(20);
  });
});
