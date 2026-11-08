import { describe, expect, test } from "bun:test";
import { decodeInput, fit, frame, inverse } from "../src/term";

describe("fit", () => {
  test("pads short text and leaves exact text alone", () => {
    expect(fit("ab", 5)).toBe("ab   ");
    expect(fit("abcde", 5)).toBe("abcde");
  });

  test("cuts long text with an ellipsis", () => {
    expect(fit("abcdefgh", 5)).toBe("abcd…");
  });

  test("counts code points, not UTF-16 units", () => {
    expect(fit("● ab", 6)).toBe("● ab  ");
    expect([...fit("●●●●●●", 3)]).toHaveLength(3);
  });

  test("a non-positive width is empty", () => {
    expect(fit("abc", 0)).toBe("");
  });
});

describe("frame", () => {
  test("places each row and blanks the rest", () => {
    const out = frame(["aa"], 2, 2);
    expect(out).toBe("\x1b[1;1Haa\x1b[2;1H  ");
  });

  test("inverse wraps and resets", () => {
    expect(inverse("x")).toBe("\x1b[7mx\x1b[0m");
  });
});

describe("decodeInput", () => {
  test("keys, arrows and named keys", () => {
    expect(decodeInput("j\x1b[A\x1b[B\r\t\x03")).toEqual([
      { kind: "key", key: "j" },
      { kind: "key", key: "up" },
      { kind: "key", key: "down" },
      { kind: "key", key: "enter" },
      { kind: "key", key: "tab" },
      { kind: "key", key: "ctrl-c" },
    ]);
  });

  test("a left click is 0-based", () => {
    expect(decodeInput("\x1b[<0;5;3M")).toEqual([{ kind: "click", col: 4, row: 2 }]);
  });

  test("release, wheel, motion and other buttons are dropped", () => {
    expect(decodeInput("\x1b[<0;5;3m\x1b[<64;5;3M\x1b[<65;5;3M\x1b[<35;5;3M\x1b[<2;5;3M")).toEqual([]);
  });

  test("unknown escape sequences are skipped whole", () => {
    expect(decodeInput("\x1b[1;5Cx")).toEqual([{ kind: "key", key: "x" }]);
  });

  test("a bare escape is a key", () => {
    expect(decodeInput("\x1b")).toEqual([{ kind: "key", key: "escape" }]);
  });

  test("several events in one chunk", () => {
    expect(decodeInput("\x1b[<0;1;1M2")).toEqual([
      { kind: "click", col: 0, row: 0 },
      { kind: "key", key: "2" },
    ]);
  });
});
