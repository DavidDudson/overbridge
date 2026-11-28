import { describe, expect, test } from "bun:test";
import { FROZEN_ICON, frozenBadge, frozenRows, renderFrozen } from "../src/frozen";
import { runThaw } from "../src/frozen-run";
import type { State } from "../src/state";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const state = {
  version: 1,
  workspaces: {
    live: { created: "2026-11-01T00:00:00Z", repos: { app: { branch: "feat/live" } } },
    newer: { created: "2026-11-01T00:00:00Z", repos: { app: { branch: "feat/b", pr: 12 } }, iceboxed: { since: "2026-11-10T00:00:00Z" } },
    older: { created: "2026-11-01T00:00:00Z", repos: { app: { branch: "feat/a" } }, iceboxed: { since: "2026-11-05T00:00:00Z", dropped: [{ repo: "app", branch: "feat/a" }] } },
  },
} satisfies State;

describe("frozenRows", () => {
  test("lists only iceboxed workspaces, oldest first, with each claim", () => {
    expect(frozenRows(state)).toEqual([
      { ws: "older", since: "2026-11-05T00:00:00Z", claims: ["app:feat/a"], dropped: true },
      { ws: "newer", since: "2026-11-10T00:00:00Z", claims: ["app:feat/b #12"], dropped: false },
    ]);
  });

  test("a hand-edited since that is not a string still lists, after the rest", () => {
    const broken: State = JSON.parse(JSON.stringify({ ...state, workspaces: { ...state.workspaces, bad: { created: "", repos: {}, iceboxed: { since: 5 } } } }));
    expect(frozenRows(broken).map((r) => r.ws)).toEqual(["older", "newer", "bad"]);
  });

  test("a record that cannot be read shows as unreadable instead of vanishing", () => {
    const broken: State = JSON.parse(JSON.stringify({ ...state, workspaces: { bad: { created: "", repos: { app: null }, iceboxed: { since: "2026-11-01T00:00:00Z" } } } }));
    expect(frozenRows(broken)).toEqual([{ ws: "bad", since: "", claims: ["unreadable record"], dropped: false }]);
  });

  test("an empty state lists nothing", () => {
    expect(frozenRows({ version: 1, workspaces: {} })).toEqual([]);
  });
});

describe("renderFrozen", () => {
  const ui = { selected: 0, offset: 0, height: 8, width: 80, message: "", now: Date.parse("2026-11-16T00:00:00Z") };

  test("draws a row per workspace with its age, the legend and the count", () => {
    const out = renderFrozen(frozenRows(state), ui).map(strip);
    expect(out).toHaveLength(8);
    expect(out[2]).toContain("older");
    expect(out[2]).toContain("11d");
    expect(out[2]).toContain("· dropped");
    expect(out[3]).toContain("app:feat/b #12");
    expect(out[6]).toContain("z thaw");
    expect(out[7]).toContain("2 frozen");
  });

  test("an empty list says how to freeze", () => {
    expect(renderFrozen([], ui).map(strip)[2]).toContain("press z");
  });

  test("an error message replaces the legend", () => {
    expect(renderFrozen([], { ...ui, message: "error: boom" }).map(strip)[6]).toContain("error: boom");
  });
});

describe("runThaw", () => {
  test("runs overbridge thaw on the workspace; success clears the message", async () => {
    const calls: string[][] = [];
    expect(await runThaw("older", async (cmd) => (calls.push(cmd), { code: 0, stderr: "" }))).toBe("");
    expect(calls[0]!.slice(-2)).toEqual(["thaw", "older"]);
  });

  test("a refusal becomes an error message", async () => {
    expect(await runThaw("older", async () => ({ code: 1, stderr: "overbridge: cannot thaw older: folder taken\n" }))).toBe("error: cannot thaw older: folder taken");
    expect(await runThaw("older", async () => ({ code: 3, stderr: "" }))).toBe("error: overbridge thaw older failed with exit code 3");
  });
});

describe("frozenBadge", () => {
  test("counts the iceboxed workspaces, one icon each", () => {
    expect(frozenBadge(state)).toEqual({ count: 2, icons: [FROZEN_ICON, FROZEN_ICON] });
  });

  test("nothing frozen has no badge", () => {
    expect(frozenBadge({ version: 1, workspaces: {} })).toBeUndefined();
  });
});
