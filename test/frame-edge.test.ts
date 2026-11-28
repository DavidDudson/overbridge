import { describe, expect, test } from "bun:test";
import { edgeIsGone, edgeRows, missedPolls, paint } from "../src/frame-edge";
import { frameEdges, isFrameSide, isPaneKind } from "../src/frame";
import { workspaceTabSpec } from "../src/layout";
import type { MuxPane } from "../src/mux";
import { boxBottom, boxSide, boxTop, textWidth } from "../src/term";

const pane = (title: string, exited = false): MuxPane => ({ id: "1", title, tab: "w1", exited });
const here = [pane("w1 · claude"), pane("sidebar")];
const GRACE = 10_000;

const plain =(s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

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

  test("the arguments the layout gives every edge pass the checks the command makes", () => {
    const spec = workspaceTabSpec("w1", ["overbridge"]);

    for (const pane of [spec.main, spec.side!]) {
      for (const edge of Object.values(frameEdges(pane))) {
        const arg = (flag: string) => edge.command[edge.command.indexOf(flag) + 1]!;
        expect(isFrameSide(arg("--side"))).toBe(true);
        expect(isPaneKind(arg("--kind"))).toBe(true);
        expect(edge.command[1]).toBe("frame-edge");
      }
    }

    expect(isFrameSide("middle")).toBe(false);
    expect(isPaneKind("sidebar")).toBe(false);
  });

  test("a repaint places every row by cursor position, with no newline that could scroll a one-row pane", () => {
    const out = paint(["a", "b"]);
    expect(out).toContain("\x1b[1;1Ha");
    expect(out).toContain("\x1b[2;1Hb");
    expect(out).not.toContain("\n");
  });
});

describe("when an edge exits", () => {
  const poll = (missed: number, panes: MuxPane[], sinceMs = GRACE) => missedPolls(missed, panes, "w1", "claude", sinceMs);

  test("never within the grace after it starts, since the pane's title lands late", () => {
    expect(poll(0, [pane("sidebar")], GRACE - 1)).toBe(0);
  });

  test("a listing with no panes says nothing, so the count holds", () => {
    expect(poll(2, [])).toBe(2);
  });

  test("a live pane resets the count, so only consecutive misses add up", () => {
    const miss = [pane("sidebar")];
    expect(poll(poll(poll(0, miss), here), miss)).toBe(1);
  });

  test("a replacement with the same title but another id is not the pane the frame surrounds", () => {
    const replacement = [{ ...pane("w1 · claude"), id: "9" }];
    expect(poll(0, replacement)).toBe(0);
    expect(missedPolls(0, replacement, "w1", "claude", GRACE, "1")).toBe(1);
    expect(missedPolls(2, here, "w1", "claude", GRACE, "1")).toBe(0);
  });

  test("a pane that exited counts as gone", () => {
    expect(poll(0, [pane("w1 · claude", true)])).toBe(1);
  });

  test("three misses in a row exit it, two do not", () => {
    const miss = [pane("sidebar")];
    expect(edgeIsGone(poll(poll(0, miss), miss))).toBe(false);
    expect(edgeIsGone(poll(poll(poll(0, miss), miss), miss))).toBe(true);
  });
});
