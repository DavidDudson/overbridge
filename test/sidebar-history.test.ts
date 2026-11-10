import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metaDir } from "../src/paths";
import { EMPTY_HISTORY, HISTORY_LIMIT, moveWithHistory, readHistory, sessionName, Travel, travel, visit, writeHistory } from "../src/sidebar-history";

const open = (...tabs: string[]) => new Set(tabs);

let tmp: string;
const savedRoot = process.env.OVERBRIDGE_ROOT;
const savedSession = process.env.ZELLIJ_SESSION_NAME;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "overbridge-history-"));
  process.env.OVERBRIDGE_ROOT = tmp;
  delete process.env.ZELLIJ_SESSION_NAME;
});

afterEach(() => {
  savedRoot === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = savedRoot);
  savedSession === undefined ? delete process.env.ZELLIJ_SESSION_NAME : (process.env.ZELLIJ_SESSION_NAME = savedSession);
  rmSync(tmp, { recursive: true, force: true });
});

describe("visit", () => {
  test("records the tab left and drops the forward list", () => {
    expect(visit({ back: ["a"], forward: ["c"] }, "b")).toEqual({ back: ["a", "b"], forward: [] });
  });

  test("keeps the most recent visits", () => {
    const long = Array.from({ length: HISTORY_LIMIT }, (_, i) => `t${i}`);
    const after = visit({ back: long, forward: [] }, "last");
    expect(after.back).toHaveLength(HISTORY_LIMIT);
    expect(after.back.at(-1)).toBe("last");
    expect(after.back[0]).toBe("t1");
  });
});

describe("travel", () => {
  const tabs = open("a", "b", "c");

  test("back then forward round-trips, like a browser", () => {
    const back = travel({ back: ["a", "b"], forward: [] }, Travel.Back, "c", tabs);
    expect(back).toEqual({ history: { back: ["a"], forward: ["c"] }, target: "b" });
    const forward = travel(back.history, Travel.Forward, "b", tabs);
    expect(forward).toEqual({ history: { back: ["a", "b"], forward: [] }, target: "c" });
  });

  test("skips closed tabs and the current tab", () => {
    expect(travel({ back: ["a", "gone", "c"], forward: [] }, Travel.Back, "c", tabs)).toEqual({
      history: { back: [], forward: ["c"] },
      target: "a",
    });
  });

  test("nowhere to go leaves the history unchanged", () => {
    const history = { back: ["gone"], forward: [] };
    expect(travel(history, Travel.Back, "a", tabs)).toEqual({ history });
    expect(travel(EMPTY_HISTORY, Travel.Forward, "a", tabs)).toEqual({ history: EMPTY_HISTORY });
  });
});

describe("history file", () => {
  test("is shared by every sidebar in a session, and separate per session", () => {
    process.env.ZELLIJ_SESSION_NAME = "one";
    writeHistory({ back: ["a"], forward: [] });
    expect(readHistory()).toEqual({ back: ["a"], forward: [] });
    expect(readHistory("one")).toEqual({ back: ["a"], forward: [] });
    expect(readHistory("two")).toEqual(EMPTY_HISTORY);
  });

  test("defaults the session name outside zellij", () => {
    expect(sessionName()).toBe("default");
  });

  test("reads a missing or invalid file as empty", () => {
    expect(readHistory("s")).toEqual(EMPTY_HISTORY);
    mkdirSync(join(metaDir(), "sidebar-history"), { recursive: true });
    const file = join(metaDir(), "sidebar-history", "s.json");
    writeFileSync(file, "not json");
    expect(readHistory("s")).toEqual(EMPTY_HISTORY);
    writeFileSync(file, JSON.stringify({ back: [1], forward: [] }));
    expect(readHistory("s")).toEqual(EMPTY_HISTORY);
    writeFileSync(file, "null");
    expect(readHistory("s")).toEqual(EMPTY_HISTORY);
  });

  test("moveWithHistory saves before moving and restores on failure", () => {
    const before = { back: ["a"], forward: [] };
    const after = { back: ["a", "b"], forward: [] };
    writeHistory(before, "s");
    expect(moveWithHistory(before, after, () => readHistory("s").back.length === 2, "s")).toBe(true);
    expect(readHistory("s")).toEqual(after);
    expect(moveWithHistory(after, { back: [], forward: [] }, () => false, "s")).toBe(false);
    expect(readHistory("s")).toEqual(after);
  });
});
