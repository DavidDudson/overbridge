import { describe, expect, test } from "bun:test";
import { edgeRows, paint } from "../src/frame-edge";
import { boxBottom, boxSide, boxTop, textWidth } from "../src/term";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("frame edges", () => {
  test("the top edge is the Workspaces title border, the bottom its closing border", () => {
    expect(edgeRows("top", "w1 · claude", 30, 1)).toEqual([boxTop("w1 · claude", 30)]);
    expect(edgeRows("bottom", "w1 · claude", 30, 1)).toEqual([boxBottom(30)]);
  });

  test("a side is one │ per row of the pane", () => {
    expect(edgeRows("left", "x", 1, 4)).toEqual([boxSide(), boxSide(), boxSide(), boxSide()]);
    expect(edgeRows("right", "x", 1, 0)).toHaveLength(1);
  });

  test("top and bottom edges fill exactly the pane's width, so the corners meet the sides", () => {
    for (const width of [8, 20, 80]) {
      expect(textWidth(plain(edgeRows("top", "a long title that must be clipped", width, 1)[0]!))).toBe(width);
      expect(textWidth(plain(edgeRows("bottom", "", width, 1)[0]!))).toBe(width);
    }
  });

  test("a repaint places every row by cursor position, with no newline that could scroll a one-row pane", () => {
    const out = paint(["a", "b"]);
    expect(out).toContain("\x1b[1;1Ha");
    expect(out).toContain("\x1b[2;1Hb");
    expect(out).not.toContain("\n");
  });
});
