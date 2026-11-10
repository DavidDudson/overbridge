import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState } from "../src/agent-state";
import { agentStateFile } from "../src/agent-state";
import { everyClaimHasPr, type SweepDeps, sweepMerged, Verdict, type VerdictInput, verdictFor } from "../src/auto-remove";
import { entries, entryLines } from "../src/sidebar";
import { readState, RemovalBlock, withState, type WorkspaceState } from "../src/state";
import { claimSweep, MERGE_SWEEP_MS } from "../src/sweep-trigger";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const ENV_KEYS = ["OVERBRIDGE_ROOT", "OVERBRIDGE_SELF", "OVERBRIDGE_NAME", "ZELLIJ", "ZELLIJ_CONFIG_DIR", "XDG_CACHE_HOME", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_CONFIG_GLOBAL"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let tmp: string;
let root: string;

function sh(cmd: string[], cwd: string) {
  const p = Bun.spawnSync({ cmd, cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")}: ${p.stderr}`);
  }
  return p.stdout.toString().trim();
}

const ob = (args: string[]) => sh([process.execPath, CLI, ...args], tmp);

/** A workspace whose `app` repo sits on a branch with one commit, claimed with PR 1. Returns that commit. */
function mergedWorkspace(ws: string): string {
  ob(["new", ws, "-r", "app"]);
  const wt = join(root, ws, "app");
  sh(["git", "switch", "-q", "-c", `feat/${ws}`], wt);
  sh(["git", "commit", "-q", "--allow-empty", "-m", "work"], wt);
  withState((s) => {
    s.workspaces[ws]!.repos.app = { branch: `feat/${ws}`, pr: 1 };
  });
  return sh(["git", "rev-parse", "HEAD"], wt);
}

/** Cache what `refreshTop` records once every PR merged at `head`. */
function cacheMerged(ws: string, head: string, at = Date.now()) {
  mkdirSync(join(root, ".overbridge", "top"), { recursive: true });
  writeFileSync(join(root, ".overbridge", "top", `${ws}.json`), JSON.stringify({ links: [], merged: { app: head }, at }));
}

function setAgent(ws: string, state: AgentState) {
  mkdirSync(join(root, ".overbridge", "agent"), { recursive: true });
  writeFileSync(agentStateFile(ws), JSON.stringify({ state, at: Date.now() }));
}

/** Sweep deps that record refreshes and removals instead of calling `gh` or zellij. */
function recordingDeps(now = Date.now()) {
  const refreshed: string[] = [];
  const removed: string[] = [];
  const deps: SweepDeps = {
    refresh: (ws) => {
      refreshed.push(ws);
    },
    remove: (ws) => {
      removed.push(ws);
      return undefined;
    },
    now,
  };
  return { deps, refreshed, removed };
}

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-auto-remove-")));
  root = join(tmp, "workspaces");
  Object.assign(process.env, {
    OVERBRIDGE_ROOT: root,
    OVERBRIDGE_SELF: `${process.execPath} ${CLI}`,
    OVERBRIDGE_NAME: "",
    ZELLIJ: "",
    ZELLIJ_CONFIG_DIR: join(tmp, "zellij-config"),
    XDG_CACHE_HOME: join(tmp, "cache"),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    GIT_CONFIG_GLOBAL: "/dev/null",
  });
  const src = join(tmp, "src");
  sh(["git", "init", "-q", "-b", "main", src], tmp);
  sh(["git", "commit", "-q", "--allow-empty", "-m", "init"], src);
  sh(["git", "clone", "-q", "--bare", src, join(tmp, "remote.git")], tmp);
  ob(["init"]);
  ob(["repo", "add", "app", join(tmp, "remote.git")]);
});

afterAll(() => {
  ENV_KEYS.forEach((k) => {
    if (saved[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = saved[k];
    }
  });
  rmSync(tmp, { recursive: true, force: true });
});

describe("verdictFor", () => {
  const workspace = (over: Partial<WorkspaceState> = {}): WorkspaceState => ({ created: "now", repos: { app: { branch: "feat/1", pr: 1 } }, ...over });
  const input = (over: Partial<VerdictInput> = {}): VerdictInput => ({ ws: "w1", workspace: workspace(), cache: { merged: { app: "abc" } }, agent: "idle", clean: () => true, ...over });

  test("removes a merged, clean workspace whose agent is at rest", () => {
    expect(verdictFor(input())).toBe(Verdict.Remove);
  });

  test("keeps a workspace whose PRs have not all merged", () => {
    expect(verdictFor(input({ cache: {} }))).toBe(Verdict.Keep);
  });

  test("marks a merged workspace with unsaved work", () => {
    expect(verdictFor(input({ clean: () => false }))).toBe(Verdict.MergedUnsaved);
  });

  test.each([
    ["busy", Verdict.Wait],
    ["bg", Verdict.Wait],
    ["waiting", Verdict.Wait],
    ["idle", Verdict.Remove],
    ["done", Verdict.Remove],
    ["end", Verdict.Remove],
    ["empty", Verdict.Remove],
    [undefined, Verdict.Remove],
  ] as const)("an agent that is %p gives %p", (agent, verdict) => {
    expect(verdictFor(input({ agent }))).toBe(verdict);
  });

  test("never removes an orchestration tab", () => {
    expect(verdictFor(input({ ws: "@root" }))).toBe(Verdict.Keep);
  });

  test("keeps a workspace already being removed, or whose last removal failed", () => {
    expect(verdictFor(input({ workspace: workspace({ removing: { since: new Date().toISOString() } }) }))).toBe(Verdict.Keep);
    expect(verdictFor(input({ workspace: workspace({ removeError: "boom" }) }))).toBe(Verdict.Keep);
  });
});

describe("everyClaimHasPr", () => {
  const w = (repos: WorkspaceState["repos"]): WorkspaceState => ({ created: "now", repos });

  test("needs at least one claimed branch, each with a PR", () => {
    expect(everyClaimHasPr(w({}))).toBe(false);
    expect(everyClaimHasPr(w({ a: { branch: "x" } }))).toBe(false);
    expect(everyClaimHasPr(w({ a: { branch: "x", pr: 1 }, b: { branch: "y" } }))).toBe(false);
    expect(everyClaimHasPr(w({ a: { branch: "x", pr: 1 } }))).toBe(true);
  });

  test("ignores released repos, which hold no branch", () => {
    expect(everyClaimHasPr(w({ a: { branch: "x", pr: 1 }, b: {} }))).toBe(true);
  });
});

describe("sweepMerged", () => {
  test("removes a merged, clean workspace with an idle agent, using the fresh cache without a refresh", () => {
    cacheMerged("m1", mergedWorkspace("m1"));
    setAgent("m1", "idle");
    const { deps, refreshed, removed } = recordingDeps();
    expect(sweepMerged(deps).m1).toBe(Verdict.Remove);
    expect(refreshed).not.toContain("m1");
    expect(removed).toEqual(["m1"]);
  });

  test("refreshes a cache older than the sweep interval first", () => {
    const now = Date.now();
    cacheMerged("m2", mergedWorkspace("m2"), now - MERGE_SWEEP_MS);
    const { deps, refreshed } = recordingDeps(now);
    sweepMerged(deps);
    expect(refreshed).toContain("m2");
  });

  test("keeps a merged workspace with unsaved work, marks its card, and clears the mark once the work is gone", () => {
    const head = mergedWorkspace("m3");
    cacheMerged("m3", head);
    const wt = join(root, "m3", "app");
    writeFileSync(join(wt, "scratch.txt"), "x");
    const first = recordingDeps();
    expect(sweepMerged(first.deps).m3).toBe(Verdict.MergedUnsaved);
    expect(first.removed).not.toContain("m3");
    expect(readState().workspaces.m3!.removalBlocked).toBe(RemovalBlock.MergedUnsaved);
    const card = entries().find((e) => e.tab === "m3")!;
    expect(entryLines(card, 1, false, 80).at(-1)).toContain("merged · unsaved work");

    rmSync(join(wt, "scratch.txt"));
    const second = recordingDeps();
    expect(sweepMerged(second.deps).m3).toBe(Verdict.Remove);
    expect(readState().workspaces.m3!.removalBlocked).toBeUndefined();
  });

  test("a commit past the merged PR's head counts as unsaved work", () => {
    cacheMerged("m4", mergedWorkspace("m4"));
    sh(["git", "commit", "-q", "--allow-empty", "-m", "after merge"], join(root, "m4", "app"));
    expect(sweepMerged(recordingDeps().deps).m4).toBe(Verdict.MergedUnsaved);
  });

  test("waits for a working agent", () => {
    cacheMerged("m5", mergedWorkspace("m5"));
    setAgent("m5", "busy");
    const { deps, removed } = recordingDeps();
    expect(sweepMerged(deps).m5).toBe(Verdict.Wait);
    expect(removed).not.toContain("m5");
  });

  test("skips a workspace with a claim that has no PR", () => {
    const head = mergedWorkspace("m6");
    cacheMerged("m6", head);
    withState((s) => {
      s.workspaces.m6!.repos.app = { branch: "feat/m6" };
    });
    const { deps, refreshed, removed } = recordingDeps();
    expect(sweepMerged(deps).m6).toBeUndefined();
    expect(refreshed).not.toContain("m6");
    expect(removed).not.toContain("m6");
  });
});

describe("claimSweep", () => {
  test("one sidebar takes each interval; the others skip until it passes", () => {
    const start = 4_000_000_000_000;
    expect(claimSweep(start)).toBe(true);
    expect(claimSweep(start + 1)).toBe(false);
    expect(claimSweep(start + MERGE_SWEEP_MS - 1)).toBe(false);
    expect(claimSweep(start + MERGE_SWEEP_MS)).toBe(true);
  });
});
