import { describe, expect, test } from "bun:test";
import { Action, actionOf, allBindings, Keyset, keyOf, legendOf, moveSelection, resolve } from "../src/keys";

describe("the key table", () => {
  test("no key means two actions", () => {
    const seen = new Map<string, Action>();

    for (const [action, keys] of allBindings()) {
      for (const key of keys) {
        expect(seen.get(key)).toBeUndefined();
        seen.set(key, action);
      }
    }
  });

  test("the standard letters", () => {
    expect(actionOf("s")).toBe(Action.Sort);
    expect(actionOf("n")).toBe(Action.New);
    expect(actionOf("o")).toBe(Action.Open);
    expect(actionOf("d")).toBe(Action.Delete);
    expect(actionOf("z")).toBe(Action.Freeze);
    expect(actionOf("g")).toBe(Action.Top);
    expect(actionOf("G")).toBe(Action.Bottom);
  });

  test("resolve answers only for a pane's own actions", () => {
    expect(resolve(Keyset.frozen, "z")).toBe(Action.Freeze);
    expect(resolve(Keyset.frozen, "s")).toBeUndefined();
    expect(resolve(Keyset.reviews, "s")).toBe(Action.Sort);
    expect(resolve(Keyset.prs, "s")).toBeUndefined();
  });

  test("every pane quits, moves and (but the picker) refreshes", () => {
    for (const set of Object.values(Keyset)) {
      if (set === Keyset.worklistDetail) continue;
      expect(set).toContain(Action.Quit);
      expect(set).toContain(Action.Down);
    }
  });
});

describe("legendOf", () => {
  test("pairs movement and names every other action by its key", () => {
    expect(legendOf(Keyset.frozen, { [Action.Freeze]: "thaw" })).toBe("j/k move   g/G ends   z thaw   r refresh   q quit");
  });

  test("an empty word leaves the action out", () => {
    expect(legendOf([Action.Enter, Action.Quit], { [Action.Enter]: "" })).toBe("q quit");
  });

  test("keyOf is the first key", () => {
    expect(keyOf(Action.Back)).toBe("escape");
  });
});

describe("moveSelection", () => {
  test("steps, clamps and jumps", () => {
    expect(moveSelection(Action.Down, 2, 3)).toBe(2);
    expect(moveSelection(Action.Up, 0, 3)).toBe(0);
    expect(moveSelection(Action.Down, 0, 3)).toBe(1);
    expect(moveSelection(Action.Bottom, 0, 5)).toBe(4);
    expect(moveSelection(Action.Top, 4, 5)).toBe(0);
    expect(moveSelection(Action.Bottom, 0, 0)).toBe(0);
    expect(moveSelection(Action.Open, 3, 5)).toBe(3);
  });
});
