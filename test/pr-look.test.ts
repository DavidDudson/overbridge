import { describe, expect, test } from "bun:test";
import { alternate, pulse, spinner } from "../src/anim";
import { ciFromRollup, conflictLook, healthOf } from "../src/pr-look";
import { badgeColor, badgeLabel, badgeOf, badgeText } from "../src/tab-badge";

const pr = { draft: false };

describe("pr look", () => {
  test("conflict is red and wins every other state", () => {
    expect(conflictLook("CONFLICTING")).toMatchObject({ color: "red", label: "conflict" });
    expect(healthOf({ ...pr, mergeable: "CONFLICTING", ci: "failure", decision: "CHANGES_REQUESTED" })).toBe("conflict");
  });
  test("health, worst first", () => {
    expect(healthOf({ ...pr, decision: "CHANGES_REQUESTED", ci: "failure" })).toBe("changes");
    expect(healthOf({ ...pr, ci: "failure" })).toBe("failing");
    expect(healthOf({ draft: true })).toBe("draft");
    expect(healthOf({ ...pr, ci: "pending" })).toBe("waiting");
    expect(healthOf({ ...pr, mergeable: "MERGEABLE", ci: "success", decision: "APPROVED" })).toBe("ready");
  });
  test("ci rollup", () => {
    expect(ciFromRollup("SUCCESS")).toBe("success");
    expect(ciFromRollup("ERROR")).toBe("failure");
    expect(ciFromRollup("PENDING")).toBe("pending");
    expect(ciFromRollup(undefined)).toBe("none");
  });
});

describe("animation", () => {
  test("spinner and pulse follow the clock", () => {
    expect(spinner(0)).not.toBe(spinner(100));
    expect(spinner(0)).toBe(spinner(1000));
    expect(pulse(0)).toBe(true);
    expect(pulse(500)).toBe(false);
    expect(alternate("a", "b", 600)).toBe("b");
  });
});

describe("tab badge", () => {
  const rows = [{ draft: false, ci: "success" as const }, { draft: false, mergeable: "CONFLICTING" }, { draft: true }];

  test("count, icons worst first, label and colour", () => {
    const b = badgeOf(rows);
    expect(b).toEqual({ count: 3, icons: ["conflict", "draft", "ready"] });
    expect(badgeLabel("reviews", b)).toBe("reviews 3");
    expect(badgeLabel("reviews", badgeOf([]))).toBe("reviews");
    expect(badgeColor(b)).toBe("red");
  });
  test("conflict pulses between same-width glyphs", () => {
    const b = badgeOf(rows);
    expect(badgeText(b, 20, 0, true)).toStartWith("💥");
    expect(badgeText(b, 20, 600, true)).toStartWith("🔥");
    expect(badgeText(b, 20, 600, false)).toStartWith("💥");
  });
  test("overflow becomes +N", () => {
    expect(badgeText(badgeOf(rows), 5)).toBe("💥 +2");
  });
});
