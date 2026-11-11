import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ZellijExec } from "../src/tab";
import { createPainter, HIDDEN_POLL_MS, isFocused, readView, shouldPoll, VIEW_MAX_AGE_MS, viewPath, type ZellijView } from "../src/zellij-view";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "overbridge-view-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOW_MS = 1_800_000_000_000;

/** A fake zellij that records its calls and answers with the given tabs, focused on `focused`. */
function fakeZellij(tabs: string[], focused: string) {
  const calls: string[][] = [];
  const exec: ZellijExec = (cmd) => {
    calls.push(cmd);
    if (cmd.includes("query-tab-names")) {
      return { ok: true, stdout: tabs.join("\n") };
    }
    if (cmd.includes("current-tab-info")) {
      return { ok: true, stdout: `name: ${focused}\nposition: 0\n` };
    }
    return { ok: false, stdout: "" };
  };
  return { exec, calls };
}

const writeCached = (view: ZellijView) => writeFileSync(viewPath(dir), JSON.stringify(view));

const touchLock = (atMs: number) => {
  const lock = join(dir, "zellij-view.lock");
  writeFileSync(lock, "");
  utimesSync(lock, atMs / 1000, atMs / 1000);
};

describe("readView", () => {
  test("asks zellij once and writes the shared file when there is none", () => {
    const zellij = fakeZellij(["a", "b"], "b");
    const view = readView({ dir, nowMs: NOW_MS, exec: zellij.exec });
    expect(view).toEqual({ order: ["a", "b"], focused: "b", atMs: NOW_MS });
    expect(zellij.calls).toHaveLength(2);
    expect(JSON.parse(readFileSync(viewPath(dir), "utf8"))).toEqual(view);
  });

  test("a fresh shared file starts no zellij client", () => {
    writeCached({ order: ["a"], focused: "a", atMs: NOW_MS - VIEW_MAX_AGE_MS + 1 });
    const zellij = fakeZellij(["x"], "x");
    expect(readView({ dir, nowMs: NOW_MS, exec: zellij.exec }).focused).toBe("a");
    expect(zellij.calls).toHaveLength(0);
  });

  test("a stale file with another pane's live lock returns the stale view without asking zellij", () => {
    writeCached({ order: ["a"], focused: "a", atMs: NOW_MS - 5_000 });
    touchLock(NOW_MS - 10);
    const zellij = fakeZellij(["x"], "x");
    expect(readView({ dir, nowMs: NOW_MS, exec: zellij.exec }).focused).toBe("a");
    expect(zellij.calls).toHaveLength(0);
  });

  test("a stale file with an old lock is refreshed", () => {
    writeCached({ order: ["a"], focused: "a", atMs: NOW_MS - 5_000 });
    touchLock(NOW_MS - 5_000);
    const zellij = fakeZellij(["a", "b"], "b");
    expect(readView({ dir, nowMs: NOW_MS, exec: zellij.exec }).focused).toBe("b");
    expect(zellij.calls).toHaveLength(2);
  });

  test("a failed zellij call gives an empty order and no focused tab, without throwing", () => {
    const exec: ZellijExec = () => ({ ok: false, stdout: "" });
    expect(readView({ dir, nowMs: NOW_MS, exec })).toEqual({ order: [], atMs: NOW_MS });
  });

  test("a corrupt shared file is treated as missing", () => {
    writeFileSync(viewPath(dir), "{not json");
    const zellij = fakeZellij(["a"], "a");
    expect(readView({ dir, nowMs: NOW_MS, exec: zellij.exec }).order).toEqual(["a"]);
  });

  test("a directory it cannot write to gives an empty view, without throwing", () => {
    const missing = join(dir, "file");
    writeFileSync(missing, "");
    const zellij = fakeZellij(["a"], "a");
    expect(readView({ dir: join(missing, "under-a-file"), nowMs: NOW_MS, exec: zellij.exec })).toEqual({ order: [], atMs: 0 });
    expect(existsSync(join(missing, "under-a-file"))).toBe(false);
  });
});

describe("focus gating", () => {
  const view = (focused?: string): ZellijView => ({ order: ["a", "b"], ...(focused === undefined ? {} : { focused }), atMs: NOW_MS });

  test("the focused tab polls every tick", () => {
    expect(shouldPoll("a", view("a"), NOW_MS - 1, NOW_MS)).toBe(true);
  });

  test("a hidden tab skips ticks within HIDDEN_POLL_MS of its last poll", () => {
    expect(shouldPoll("a", view("b"), NOW_MS - HIDDEN_POLL_MS + 1, NOW_MS)).toBe(false);
  });

  test("a hidden tab polls once HIDDEN_POLL_MS has passed", () => {
    expect(shouldPoll("a", view("b"), NOW_MS - HIDDEN_POLL_MS, NOW_MS)).toBe(true);
  });

  test("a hidden tab polls on the first tick after it is focused", () => {
    const lastPollAtMs = NOW_MS - 1_000;
    expect(shouldPoll("a", view("b"), lastPollAtMs, NOW_MS)).toBe(false);
    expect(shouldPoll("a", view("a"), lastPollAtMs, NOW_MS + 1_000)).toBe(true);
  });

  test("an unknown focus counts as focused, so no pane goes quiet when zellij cannot answer", () => {
    expect(isFocused("a", view())).toBe(true);
    expect(shouldPoll("a", view(), NOW_MS, NOW_MS)).toBe(true);
  });
});

describe("createPainter", () => {
  test("writes a frame only when it differs from the last one written", () => {
    const written: string[] = [];
    const painter = createPainter((text) => written.push(text));
    painter.paint("one");
    painter.paint("one");
    painter.paint("two");
    painter.paint("two");
    expect(written).toEqual(["one", "two"]);
  });

  test("invalidate forces the next frame out even when unchanged", () => {
    const written: string[] = [];
    const painter = createPainter((text) => written.push(text));
    painter.paint("one");
    painter.invalidate();
    painter.paint("one");
    expect(written).toEqual(["one", "one"]);
  });
});
