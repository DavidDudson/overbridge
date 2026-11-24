import { describe, expect, test } from "bun:test";
import { alternate, pulse, spinner } from "../src/anim";
import { ciFromRollup, conflictLook, HEALTH_LOOK, healthOf } from "../src/pr-look";
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
    expect(b).toEqual({ count: 3, icons: [HEALTH_LOOK.conflict, HEALTH_LOOK.draft, HEALTH_LOOK.ready] });
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

import { animate } from "../src/sidebar-motion";
import { entryLines, type Entry } from "../src/sidebar";
import { Motion } from "../src/config";
import { readBadge } from "../src/tab-badge-read";
import { CHECK_RUNNING_ICON, CHECK_WAITING_ICON, checksBadge } from "../src/checks";
import { FROZEN_ICON } from "../src/frozen";
import { pulsesIcon } from "../src/tab-badge";
import type { Ticket } from "../src/check-queue";

describe("sidebar badge", () => {
  const card = (rows: { draft: boolean; mergeable?: string }[]): Entry => ({ tab: "@reviews", section: "orchestration", glyph: "  ", label: badgeLabel("reviews", badgeOf(rows)), badge: badgeOf(rows) });

  test("card shows the count and icons, conflict pulses with motion", () => {
    const e = card([{ draft: false, mergeable: "CONFLICTING" }, { draft: false }]);
    const plain = (es: Entry[], now: number) => entryLines(animate(es, now, Motion.WhileActive)[0]!, 0, false, 30).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain([e], 0)).toContain("reviews 2");
    expect(plain([e], 0)).toContain("💥");
    expect(plain([e], 600)).toContain("🔥");
    expect(animate([e], 600, Motion.Off)[0]).toBe(e);
  });
  const empty = { version: 1 as const, workspaces: {} };
  const frozen = { version: 1 as const, workspaces: { a: { created: "", repos: {}, iceboxed: { since: "2026-11-01T00:00:00Z" } } } };
  const ticket: Ticket = { ws: "w", repo: "r", command: "just test", queuedAtMs: 0, pid: 1 };

  test("a tab without a list has no badge", () => {
    expect(readBadge("@root", { state: empty })).toBeUndefined();
  });
  test("@frozen reads state and @checks the queue it is given; with no queue @checks has none", () => {
    expect(readBadge("@frozen", { state: frozen })?.icons).toEqual([FROZEN_ICON]);
    expect(readBadge("@checks", { state: frozen, queue: { running: [ticket], waiting: [ticket] } })?.icons).toEqual([CHECK_RUNNING_ICON, CHECK_WAITING_ICON]);
    expect(readBadge("@checks", { state: frozen })).toBeUndefined();
  });
  test("only an icon with a second glyph pulses, so a still badge never stamps the clock", () => {
    expect(pulsesIcon(HEALTH_LOOK.conflict)).toBe(true);
    expect(pulsesIcon(HEALTH_LOOK.ready)).toBe(false);
    expect(pulsesIcon(CHECK_WAITING_ICON)).toBe(false);
    const still: Entry = { tab: "@checks", section: "orchestration", glyph: "  ", label: "check queue 1", badge: checksBadge({ running: [], waiting: [ticket] }) };
    expect(animate([still], 600, Motion.WhileActive)[0]).toBe(still);
  });
});
