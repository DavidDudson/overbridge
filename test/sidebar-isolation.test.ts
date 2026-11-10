import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentStateFile, UNKNOWN_GLYPH } from "../src/agent-state";
import { CleanupCause, CleanupOutcome, cleanupRecords, cleanupRows } from "../src/cleanup-log";
import { metaDir } from "../src/paths";
import { EMPTY_MODEL, type Entry, entries, entryLines, gather, inFlightCleanups, type Model, renderSidebar, Section, type SidebarReaders } from "../src/sidebar";
import { type State, tryReadState, withState, workspaceFault } from "../src/state";
import { readTopCache, readTopCacheChecked, topCacheFault } from "../src/top";

const plain = (rows: string[]) => rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
const cacheFile = (ws: string) => join(metaDir(), "top", `${ws}.json`);
const writeCache = (ws: string, text: string) => {
  mkdirSync(join(metaDir(), "top"), { recursive: true });
  writeFileSync(cacheFile(ws), text);
};
const workspace = (title?: string) => ({ created: "now", repos: { r: { branch: "b" } }, ...(title ? { title } : {}) });
/** A state whose records are raw JSON shapes, including malformed ones `State` forbids. */
const malformedState = (workspaces: Record<string, unknown>): State => ({ version: 1, workspaces }) as unknown as State;
const byTab = (list: Entry[]) => Object.fromEntries(list.filter((e) => e.section === Section.Workspaces).map((e) => [e.tab, e]));

let tmp: string;
const savedRoot = process.env.OVERBRIDGE_ROOT;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "overbridge-isolation-"));
  process.env.OVERBRIDGE_ROOT = tmp;
});

afterEach(() => {
  savedRoot === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = savedRoot);
  rmSync(tmp, { recursive: true, force: true });
});

describe("top cache shape", () => {
  test("a misshapen cache is the empty cache plus why; a missing one is the empty cache alone", () => {
    expect(readTopCacheChecked("none")).toEqual({ cache: { links: [], at: 0 } });
    for (const [text, why] of [
      ["null", "got null"],
      ["[]", "got an array"],
      ["42", "got a number"],
      ['{"title": 7}', "title is a number"],
      ['{"headline": ["x"], "links": []}', "headline is an array"],
      ['{"links": {}}', "links is a object"],
      ['{"links": [], "merged": "yes"}', "merged is a string"],
      ["{not json", "JSON"],
    ] as const) {
      writeCache("w1", text);
      const read = readTopCacheChecked("w1");
      expect(read.cache).toEqual({ links: [], at: 0 });
      expect(read.fault).toContain(why);
      expect(readTopCache("w1")).toEqual({ links: [], at: 0 });
    }
  });

  test("a cache with the right types passes through unchanged", () => {
    const cache = { headline: "12 Add dark mode", title: "Add dark mode", links: [], at: 5, prsOpen: true, merged: { r: "abc" }, buttons: {} };
    expect(topCacheFault(cache)).toBeUndefined();
    writeCache("w1", JSON.stringify(cache));
    expect(readTopCacheChecked("w1")).toEqual({ cache });
  });
});

describe("workspace records", () => {
  test("names what is wrong with a record, and nothing for a good one", () => {
    expect(workspaceFault({ created: "now", repos: {} })).toBeUndefined();
    expect(workspaceFault({ created: "now", repos: {}, removing: { since: new Date().toISOString() } })).toBeUndefined();
    expect(workspaceFault(null)).toContain("null");
    expect(workspaceFault("ws")).toContain("a string");
    expect(workspaceFault({ created: "now" })).toContain("no repos");
    expect(workspaceFault({ created: "now", repos: [] })).toContain("repos as an array");
    expect(workspaceFault({ created: "now", repos: {}, removing: null })).toContain("removing as null");
    expect(workspaceFault({ created: "now", repos: {}, removing: {} })).toContain("no valid since");
    expect(workspaceFault({ created: "now", repos: {}, removing: { since: "yesterday" } })).toContain("no valid since");
  });

  test("tryReadState keeps the fallback and names the file when state will not parse", () => {
    const fallback: State = { version: 1, workspaces: { kept: workspace() } };
    expect(tryReadState(fallback)).toEqual({ state: { version: 1, workspaces: {} } });
    mkdirSync(metaDir(), { recursive: true });
    for (const text of ["{not json", "null", "[]", '{"version": 1}', '{"version": 1, "workspaces": null}']) {
      writeFileSync(join(metaDir(), "state.json"), text);
      const read = tryReadState(fallback);
      expect(read.state).toBe(fallback);
      expect(read.fault).toContain("state.json");
    }
    writeFileSync(join(metaDir(), "state.json"), JSON.stringify(fallback));
    expect(tryReadState()).toEqual({ state: fallback });
  });
});

describe("one bad workspace in the list", () => {
  beforeEach(() => {
    withState((s) => {
      s.workspaces.good = workspace();
      s.workspaces.bad = workspace();
      s.workspaces.other = workspace();
    });
    writeCache("good", JSON.stringify({ title: "Add dark mode", links: [], at: 1 }));
    writeCache("other", JSON.stringify({ title: "Fix login", links: [], at: 1 }));
    mkdirSync(join(metaDir(), "agent"), { recursive: true });
    writeFileSync(agentStateFile("good"), JSON.stringify({ state: "waiting", at: Date.now() }));
  });

  test("a misshapen top cache marks only its own card, with the workspace name as its label", () => {
    for (const text of ["null", "[]", "42", '{"title": 7}']) {
      writeCache("bad", text);
      const cards = byTab(entries([]));
      expect(cards.bad!.label).toBe("bad");
      expect(cards.bad!.fault).toContain("top cache");
      expect(cards.good).toMatchObject({ label: "Add dark mode", state: "waiting", glyph: "❓" });
      expect(cards.good!.fault).toBeUndefined();
      expect(cards.other).toMatchObject({ label: "Fix login" });
    }
  });

  test("a malformed state record marks only its own card, and never hides it as removing", () => {
    for (const bad of [null, "ws", { created: "now" }, { created: "now", repos: {}, removing: null }, { created: "now", repos: {}, removing: {} }]) {
      withState((s) => {
        (s.workspaces as Record<string, unknown>).bad = bad;
      });
      const cards = byTab(entries([]));
      expect(cards.bad).toMatchObject({ label: "bad", glyph: UNKNOWN_GLYPH });
      expect(cards.bad!.fault).toContain("state record");
      expect(cards.good).toMatchObject({ label: "Add dark mode", state: "waiting" });
      expect(Object.keys(cards).sort()).toEqual(["bad", "good", "other"]);
    }
  });

  test("a card whose readers throw becomes a fault card and the rest are built", () => {
    const state: State = { version: 1, workspaces: { good: workspace(), bad: workspace() } };
    Object.defineProperty(state.workspaces, "bad", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    const cards = byTab(entries([], state));
    expect(cards.bad).toMatchObject({ label: "bad", fault: "boom" });
    expect(cards.good!.fault).toBeUndefined();
  });

  test("the fault shows on the card's status line in red, ahead of any other status", () => {
    const rows = plain(entryLines({ tab: "bad", section: Section.Workspaces, glyph: UNKNOWN_GLYPH, label: "bad", fault: "top cache: got null", error: "hook failed", state: "waiting" }, 0, false, 40));
    expect(rows[1]).toBe("     error: top cache: got null");
    const raw = entryLines({ tab: "bad", section: Section.Workspaces, glyph: UNKNOWN_GLYPH, label: "bad", fault: "x" }, 0, false, 20)[1]!;
    expect(raw).toContain("\x1b[31m");
  });

  test("a malformed removing record is left out of the cleanups in flight", () => {
    const since = new Date().toISOString();
    const state = malformedState({
      going: { ...workspace(), removing: { since } },
      broken: { ...workspace(), removing: {} },
      gone: null,
    });
    expect(inFlightCleanups(state).map((r) => r.label)).toEqual(["going"]);
  });
});

describe("one poll of the sidebar", () => {
  const good: State = { version: 1, workspaces: { w1: workspace(), w2: workspace() } };
  const list = (state: State): Entry[] => Object.keys(state.workspaces).map((tab) => ({ tab, section: Section.Workspaces, glyph: "○", label: tab }));
  const okReaders = (): SidebarReaders => ({
    tabOrder: () => ["w1", "w2"],
    keepOrchestration: () => {},
    sweep: () => {},
    readState: () => ({ state: good }),
    entries: (_order, state) => list(state),
    reap: () => ({ unsaved: new Set(), faults: new Map() }),
    status: () => ["🧹 next check 10s"],
    limits: () => undefined,
  });
  const throwing = (what: string) => () => {
    throw new Error(`${what} broke`);
  };

  test("a good poll has no fault", () => {
    const model = gather(okReaders(), 26, EMPTY_MODEL);
    expect(model.fault).toBeUndefined();
    expect(model.list.map((e) => e.tab)).toEqual(["w1", "w2"]);
    expect(model.status).toEqual(["🧹 next check 10s"]);
    expect(model.state).toBe(good);
  });

  test("a state file that will not parse keeps the last good list and names the file; the next poll recovers", () => {
    const first = gather(okReaders(), 26, EMPTY_MODEL);
    const readers = okReaders();
    readers.readState = (fallback) => ({ state: fallback, fault: "state.json: Unexpected token" });
    readers.entries = (_order, state) => list(state);
    const broken = gather(readers, 26, first);
    expect(broken.fault).toBe("state.json: Unexpected token");
    expect(broken.list.map((e) => e.tab)).toEqual(["w1", "w2"]);
    expect(broken.state).toBe(good);
    const recovered = gather(okReaders(), 26, broken);
    expect(recovered.fault).toBeUndefined();
  });

  test("each reader that throws is reported once and the rest still run", () => {
    const last = gather(okReaders(), 26, EMPTY_MODEL);
    const cases: [keyof SidebarReaders, (m: Model) => void][] = [
      ["tabOrder", (m) => expect(m.list.map((e) => e.tab)).toEqual(["w1", "w2"])],
      ["keepOrchestration", (m) => expect(m.list).toHaveLength(2)],
      ["sweep", (m) => expect(m.list).toHaveLength(2)],
      ["readState", (m) => expect(m.list).toHaveLength(2)],
      ["entries", (m) => expect(m.list).toEqual(last.list)],
      ["reap", (m) => expect(m.list).toHaveLength(2)],
      ["status", (m) => expect(m.status).toEqual([])],
      ["limits", (m) => expect(m.limits).toBeUndefined()],
    ];
    for (const [name, check] of cases) {
      const readers: SidebarReaders = { ...okReaders(), [name]: throwing(name) };
      const model = gather(readers, 26, last);
      expect(model.fault).toContain(`${name} broke`);
      check(model);
    }
  });

  test("the reaper's faults land on their cards; its unsaved ones keep their mark", () => {
    const readers = okReaders();
    readers.reap = () => ({ unsaved: new Set(["w2"]), faults: new Map([["w1", "no workspace 'w1'"]]) });
    const model = gather(readers, 26, EMPTY_MODEL);
    expect(model.list[0]).toMatchObject({ tab: "w1", fault: "no workspace 'w1'" });
    expect(model.list[1]).toMatchObject({ tab: "w2", unsaved: true });
    expect(model.fault).toBeUndefined();
  });

  test("a fault footer renders inside the frame", () => {
    const rows = renderSidebar(list(good), 0, 0, 12, 30, undefined, 0, "", [], { kind: "error", message: "state.json: bad" });
    expect(rows).toHaveLength(12);
    expect(plain(rows).at(-2)).toContain("state.json: bad");
  });
});

describe("cleanup records from state", () => {
  test("a record without a label or a time is left out, and so is a log that is not a list", () => {
    const now = 100_000;
    const good = { ws: "a", label: "#a fix", atMs: now - 1000, outcome: CleanupOutcome.Removed, cause: CleanupCause.Cleanup };
    const log = [
      good,
      { ws: "b", atMs: now - 1000, outcome: CleanupOutcome.Removed, cause: CleanupCause.Cleanup },
      { ws: "c", label: "#c fix", outcome: CleanupOutcome.Failed, cause: CleanupCause.Cleanup },
      { ws: "d", label: 7, atMs: "then" },
      null,
    ];
    expect(cleanupRecords(log)).toEqual([good]);
    expect(cleanupRecords(undefined)).toEqual([]);
    expect(cleanupRecords({ a: good })).toEqual([]);
    expect(plain(cleanupRows([], cleanupRecords(log), 30, now, now - 5000)).slice(1)).toEqual(["🧹 removed #a fix"]);
  });
});
