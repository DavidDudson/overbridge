import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type AheadDeps, aheadRows } from "../src/ahead";
import { phase, workspaceClaudeArgs } from "../src/commands";
import { metaDir } from "../src/paths";
import { entries, entryLines, type Entry, Section } from "../src/sidebar";
import { type State, withState } from "../src/state";
import { clearPhase, parseLayer, type PhaseRecord, phasePath, readPhase, taskStatus, writePhase } from "../src/task-status";
import type { PrStatus, TopLink } from "../src/top";

let tmp: string;
const saved = { root: process.env.OVERBRIDGE_ROOT, name: process.env.OVERBRIDGE_NAME };
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "overbridge-task-"));
  process.env.OVERBRIDGE_ROOT = tmp;
});
afterEach(() => {
  saved.root === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = saved.root);
  saved.name === undefined ? delete process.env.OVERBRIDGE_NAME : (process.env.OVERBRIDGE_NAME = saved.name);
  rmSync(tmp, { recursive: true, force: true });
});

const link = (status: PrStatus, pr: Partial<NonNullable<TopLink["pr"]>> = {}): TopLink => ({
  label: "PR #1",
  url: "u",
  status,
  pr: { repo: "app", number: 1, title: "t", draft: false, dir: "/x", stack: [], ...pr },
});
const reviewer = (state: "reviewing" | "reviewed" | "comments" | "changes") => ({ name: "Copilot" as const, state });

describe("taskStatus", () => {
  test("no PR: the recorded phase, with the stack layer on implement", () => {
    const at = 0;
    expect(taskStatus({ links: [] }, { phase: "plan", at })).toBe("plan");
    expect(taskStatus({ links: [] }, { phase: "implement", layer: { n: 2, of: 3 }, at })).toBe("implement (stack 2/3)");
    expect(taskStatus({ links: [] }, { phase: "mob-review", at })).toBe("mob review");
  });
  test("no PR and no phase: ticket until an item is known, then started", () => {
    expect(taskStatus({ links: [] })).toBe("ticket");
    expect(taskStatus({ links: [], headline: "12 Add x" })).toBe("started");
  });
  test.each<[string, TopLink, string]>([
    ["draft", link("blocked", { draft: true }), "draft PR"],
    ["open, build pending", link("pending"), "open PR"],
    ["waiting on a reviewer", link("pending", { reviewers: [reviewer("reviewing")] }), "waiting AI review"],
    ["comments", link("mergeable", { reviewers: [reviewer("comments")] }), "review feedback"],
    ["changes requested", link("mergeable", { reviewers: [reviewer("changes")] }), "review feedback"],
    ["failing beats feedback", link("failing", { reviewers: [reviewer("comments")] }), "build failing"],
    ["conflict beats feedback", link("conflict", { reviewers: [reviewer("changes")] }), "conflicts"],
    ["feedback beats waiting", link("mergeable", { reviewers: [reviewer("comments"), reviewer("reviewing")] }), "review feedback"],
    ["mergeable", link("mergeable", { reviewers: [reviewer("reviewed")] }), "mergeable"],
    ["closed", link("closed"), "closed PR"],
    ["merged link", link("merged"), "merged"],
    ["layer on any status", link("pending", { layer: { n: 1, of: 2 }, claimed: true, stack: [1, 2] }), "open PR (stack 1/2)"],
  ])("a PR decides over any phase: %s", (_name, l, expected) => {
    expect(taskStatus({ links: [l] }, { phase: "plan", at: 0 })).toBe(expected);
  });
  test("a PR the workspace does not claim does not decide", () => {
    expect(taskStatus({ links: [link("pending", { claimed: false })] }, { phase: "plan", at: 0 })).toBe("plan");
  });
  test("merged wins, and a stacked PR shows its layer", () => {
    expect(taskStatus({ links: [link("blocked", { draft: true })], merged: { app: "abc" } })).toBe("merged");
    expect(taskStatus({ links: [link("blocked", { draft: true, claimed: true, stack: [1, 2, 3], layer: { n: 2, of: 3 } })] })).toBe("draft PR (stack 2/3)");
  });
});

describe("phase store", () => {
  const raw = (ws: string, text: string) => {
    mkdirSync(dirname(phasePath(ws)), { recursive: true });
    writeFileSync(phasePath(ws), text);
  };
  test("round-trips and clears", () => {
    writePhase("w1", "implement", { n: 1, of: 2 }, 5);
    expect(readPhase("w1")).toEqual({ phase: "implement", layer: { n: 1, of: 2 }, at: 5 });
    clearPhase("w1");
    expect(readPhase("w1")).toBeUndefined();
  });
  test.each([
    ["not json", "not json"],
    ["an unknown phase", '{"phase":"bogus","at":1}'],
    ["no phase", "{}"],
  ])("junk reads as none: %s", (_name, text) => {
    raw("w", text);
    expect(readPhase("w")).toBeUndefined();
  });
  test("a bad layer is dropped, the phase kept", () => {
    for (const layer of ['{"n":"x","of":2}', '{"n":5,"of":2}', '{"n":0,"of":3}', '{"n":1.5,"of":3}']) {
      raw("w", `{"phase":"implement","layer":${layer},"at":1}`);
      expect(readPhase("w")).toEqual<PhaseRecord>({ phase: "implement", at: 1 });
    }
  });
  test("parseLayer", () => {
    expect(parseLayer("2/3")).toEqual({ n: 2, of: 3 });
    for (const bad of ["0/3", "4/3", "x", "2", "2/"]) expect(parseLayer(bad)).toBeUndefined();
  });
});

describe("overbridge phase", () => {
  beforeEach(() => {
    withState((s) => {
      s.workspaces.w = { created: "t", repos: {} };
    });
    process.env.OVERBRIDGE_NAME = "w";
  });
  test("records a phase and its layer, and --clear forgets it", () => {
    phase(["implement"], "2/3", false);
    expect(readPhase("w")).toMatchObject({ phase: "implement", layer: { n: 2, of: 3 } });
    phase([], undefined, true);
    expect(readPhase("w")).toBeUndefined();
  });
  test.each<[string, string[], string | undefined]>([
    ["an unknown phase", ["bogus"], undefined],
    ["no phase", [], undefined],
    ["extra arguments", ["plan", "x"], undefined],
    ["a layer past the stack", ["implement"], "4/3"],
    ["a malformed layer", ["implement"], "x"],
    ["a layer on a phase that has none", ["plan"], "1/2"],
  ])("rejects %s and writes nothing", (_name, args, stack) => {
    expect(() => phase(args, stack, false)).toThrow();
    expect(readPhase("w")).toBeUndefined();
  });
});

describe("sidebar card", () => {
  const state = (): State => ({ version: 1, workspaces: { w: { created: "t", repos: {} } } });
  const card = () => entries([], state()).find((c) => c.tab === "w")!;
  test("carries the task from the recorded phase", () => {
    expect(card().task).toBe("ticket");
    writePhase("w", "plan");
    expect(card().task).toBe("plan");
  });
  test("a card whose cache is unreadable has a fault and no task", () => {
    mkdirSync(join(metaDir(), "top"), { recursive: true });
    writeFileSync(join(metaDir(), "top", "w.json"), "{ not json");
    writePhase("w", "plan");
    expect(card().fault).toBeDefined();
    expect(card().task).toBeUndefined();
  });
});

describe("status line", () => {
  const e = (over: Partial<Entry>): Entry => ({ tab: "a", section: Section.Workspaces, glyph: "○", label: "a", ...over });
  const sub = (entry: Entry) => entryLines(entry, 0, false, 50)[1]!;
  test("`claude status - task status`", () => {
    expect(sub(e({ state: "busy", task: "implement (stack 2/3)" }))).toContain("working - implement (stack 2/3)");
    expect(sub(e({ state: "bg", task: "draft PR" }))).toContain("background tasks - draft PR");
    expect(sub(e({ state: "empty", task: "plan" }))).toContain("empty - plan");
  });
  test("no recorded session still shows the task; an orchestration tab shows no task", () => {
    expect(sub(e({ task: "open PR" }))).toContain("no session - open PR");
    expect(sub(e({ state: "idle" }))).toContain("idle");
    expect(sub(e({ state: "idle" }))).not.toContain(" - ");
  });
});

describe("session name", () => {
  test("a workspace's Claude is named after the workspace", () => {
    expect(workspaceClaudeArgs("m4-conditions", "/s.json", ["--continue"])).toEqual(["claude", "--settings", "/s.json", "--name", "m4-conditions", "--continue"]);
  });
});

describe("aheadRows", () => {
  const state: State = {
    version: 1,
    workspaces: {
      a: { created: "t", repos: { app: { branch: "feat/x", pr: 4 } } },
      b: { created: "t", repos: { app: { branch: "main" } } },
      c: { created: "t", repos: { app: { branch: "feat/y" } }, iceboxed: { since: "t" } },
      d: { created: "t", repos: { app: { branch: "feat/z" } } },
    },
  };
  type Counts = { ahead?: string | undefined; behind?: string | undefined };
  const deps = (heads: Record<string, string>, counts: Counts, over: Partial<AheadDeps> = {}): AheadDeps => ({
    state: () => state,
    base: () => "origin/main",
    exists: () => true,
    head: (wt) => heads[wt.split("/").at(-2)!] ?? "HEAD",
    dirty: () => false,
    git: (_wt, args) => {
      if (args[0] === "rev-list") return args[2]!.startsWith("HEAD") ? counts.behind : counts.ahead;
      return args.includes("--format=%aI") ? "2026-11-01T00:00:00+00:00" : "one\ntwo";
    },
    ...over,
  });
  const quiet = () => {};
  test("lists live branches with commits main lacks, by workspace name", () => {
    const rows = aheadRows(deps({ a: "feat/x", b: "main", c: "feat/y", d: "HEAD" }, { ahead: "2", behind: "5" }), quiet);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ws: "a", session: "a", branch: "feat/x", ahead: 2, behind: 5, pr: 4, dirty: false, subjects: ["one", "two"] });
  });
  test("a claim with no PR has no pr, and a dirty worktree says so", () => {
    const [row] = aheadRows(deps({ d: "feat/z" }, { ahead: "1", behind: "0" }, { dirty: () => true }), quiet);
    expect(row).toMatchObject({ ws: "d", dirty: true });
    expect("pr" in row!).toBe(false);
  });
  test.each<[string, Counts, Partial<AheadDeps>]>([
    ["nothing ahead", { ahead: "0", behind: "1" }, {}],
    ["both counts fail", { ahead: undefined, behind: undefined }, {}],
    ["only the behind count fails", { ahead: "2", behind: undefined }, {}],
    ["a missing worktree", { ahead: "2", behind: "0" }, { exists: () => false }],
  ])("is left out: %s", (_name, counts, over) => {
    expect(aheadRows(deps({ a: "feat/x" }, counts, over), quiet)).toEqual([]);
  });
  test("a worktree whose read throws is reported and skipped, the rest still listed", () => {
    const warnings: string[] = [];
    const throwing = deps({ a: "feat/x", d: "feat/z" }, { ahead: "1", behind: "0" }, {
      base: (repo) => {
        if (warnings.length === 0 && repo === "app") throw new Error("repo app is not registered");
        return "origin/main";
      },
    });
    const rows = aheadRows(throwing, (m) => warnings.push(m));
    expect(warnings).toEqual(["ahead: skipped a/app: repo app is not registered"]);
    expect(rows.map((r) => r.ws)).toEqual(["d"]);
  });
});
