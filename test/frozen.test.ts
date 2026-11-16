import { describe, expect, test } from "bun:test";
import { frozenRows, renderFrozen } from "../src/frozen";
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
    expect(out[6]).toContain("t thaw");
    expect(out[7]).toContain("2 frozen");
  });

  test("an empty list says how to freeze", () => {
    expect(renderFrozen([], ui).map(strip)[2]).toContain("press f");
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
