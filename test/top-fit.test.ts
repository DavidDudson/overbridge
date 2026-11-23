import { describe, expect, test } from "bun:test";
import { PaneResize } from "../src/mux";
import { afterStep, planFit, settle } from "../src/top-fit";

describe("planFit", () => {
  test("grows a short pane, and shrinks only while a known step leaves it tall enough", () => {
    expect(planFit(5, 8, {})).toBe(PaneResize.Grow);
    expect(planFit(11, 8, { stepRows: 3 })).toBe(PaneResize.Shrink);
    expect(planFit(10, 8, { stepRows: 3 })).toBeUndefined();
    expect(planFit(8, 8, { stepRows: 3 })).toBeUndefined();
  });

  test("with no step size known, a tall pane shrinks once to learn it, and an overshoot grows back and settles", () => {
    expect(planFit(9, 6, {})).toBe(PaneResize.Shrink);
    const learnt = afterStep({}, 9, 5, 6);
    expect(planFit(5, 6, learnt)).toBe(PaneResize.Grow);
    expect(planFit(9, 6, afterStep(learnt, 5, 9, 6))).toBeUndefined();
  });

  test("leaves a settled height alone, so a resize by hand stays, until the needed height changes", () => {
    const state = settle({ stepRows: 3 }, 8);
    expect(planFit(20, 8, state)).toBeUndefined();
    expect(planFit(5, 8, state)).toBeUndefined();
    expect(planFit(5, 9, state)).toBe(PaneResize.Grow);
  });

  test("a step that changed nothing stops further steps at that height", () => {
    const stuck = afterStep({}, 5, 5, 8);
    expect(stuck.stuckRows).toBe(8);
    expect(planFit(5, 8, stuck)).toBeUndefined();
    expect(planFit(5, 9, stuck)).toBe(PaneResize.Grow);
    expect(afterStep({}, 5, 8, 8)).toEqual({ stepRows: 3 });
    expect(afterStep({}, 8, 5, 5)).toEqual({ stepRows: 3 });
  });
});
