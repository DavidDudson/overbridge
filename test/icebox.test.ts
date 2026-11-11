import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queueDir, stopChecksFor, ticketName, type Ticket } from "../src/check-queue";
import { handoffStamp, HandoffReason, renderHandoff } from "../src/handoff";
import { icebox, type IceboxDeps, prunable, THAW_PROMPT, thaw } from "../src/icebox";
import { entries, icedRows } from "../src/sidebar";
import { isIceboxed, readState, withState } from "../src/state";
import { newTabKdl } from "../src/layout";
import { showTab } from "../src/start";
import type { RunResult } from "../src/util";
import { mkdirSync } from "node:fs";

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
const ok = (stdout = ""): RunResult => ({ ok: true, code: 0, stdout, stderr: "" });

/** Deps that record zellij calls and counts of what was stopped; `focused` is the tab zellij reports as current. */
function fakeDeps(listTabs: string, focused = "") {
  const calls: string[][] = [];
  const stopped = { apps: [] as string[], checks: [] as string[] };
  const deps: IceboxDeps = {
    exec: (cmd) => {
      calls.push(cmd);
      if (cmd[2] === "list-tabs") return ok(listTabs);
      return cmd[2] === "current-tab-info" && focused ? ok(`name: ${focused}\n`) : ok();
    },
    inZellij: true,
    stopApps: async (ws) => void stopped.apps.push(ws),
    stopChecks: (ws) => (stopped.checks.push(ws), 0),
  };
  return { deps, calls, stopped };
}

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-icebox-")));
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
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });
  rmSync(tmp, { recursive: true, force: true });
});

describe("renderHandoff", () => {
  test("names the reason, workspace and a State row per repo", () => {
    const text = renderHandoff({ ws: "w", reason: HandoffReason.Icebox, next: "thaw it", rows: [{ repo: "app", branch: "feat/x", head: "abc1234", pr: 7 }] });
    expect(text).toContain("Next: thaw it\nReason: icebox\nWorkspace: w");
    expect(text).toContain("| app | feat/x | abc1234 | none |");
    expect(text).toContain("PR #7");
  });
  test("stamps UTC time so file names sort", () => {
    expect(handoffStamp(new Date("2026-03-04T05:06:07Z"))).toBe("20260304-0506");
  });
});

describe("icebox and thaw", () => {
  test("refuses a workspace with uncommitted changes and changes nothing", async () => {
    ob(["new", "dirty", "-r", "app"]);
    writeFileSync(join(root, "dirty", "app", "scratch.txt"), "wip");
    const { deps, calls, stopped } = fakeDeps("");
    await expect(icebox("dirty", {}, deps)).rejects.toThrow("uncommitted");
    expect(isIceboxed(readState().workspaces.dirty)).toBe(false);
    expect(calls).toEqual([]);
    expect(stopped.apps).toEqual([]);
  });

  test("refuses an orchestration tab", async () => {
    await expect(icebox("@root", {}, fakeDeps("").deps)).rejects.toThrow("orchestration");
  });

  test("pauses a clean workspace: stops work, writes a handoff, keeps claims, closes the tab", async () => {
    ob(["new", "calm", "-r", "app"]);
    const before = readState().workspaces.calm!.repos;
    const { deps, calls, stopped } = fakeDeps("TAB_ID  POSITION  NAME\n5  1  calm\n");
    const handoff = await icebox("calm", {}, deps);
    expect(stopped).toEqual({ apps: ["calm"], checks: ["calm"] });
    expect(existsSync(handoff)).toBe(true);
    expect(readFileSync(handoff, "utf8")).toContain("Reason: icebox");
    const w = readState().workspaces.calm!;
    expect(w.iceboxed?.handoff).toBe(handoff);
    expect(w.repos).toEqual(before);
    expect(calls.some((c) => c[2] === "close-tab-by-id" && c[3] === "5")).toBe(true);
    await expect(icebox("calm", {}, fakeDeps("").deps)).rejects.toThrow("already iceboxed");
  });

  test("an iceboxed workspace has no sidebar card, only a row, and shows in status --json", () => {
    expect(entries([]).map((e) => e.tab)).not.toContain("calm");
    expect(icedRows(readState(), 40).join("\n")).toContain("calm");
    const rows = JSON.parse(ob(["status", "--all", "--json"])) as { ws: string; iceboxed: boolean }[];
    expect(rows.find((r) => r.ws === "calm")?.iceboxed).toBe(true);
    expect(rows.find((r) => r.ws === "dirty")?.iceboxed).toBe(false);
  });

  test("the generated layout skips an iceboxed workspace", () => {
    expect(ob(["layout"])).not.toContain('tab name="calm"');
  });

  test("thaw clears the mark and opens the tab with the handoff prompt", () => {
    const opened: [string, string][] = [];
    thaw("calm", { open: (ws, prompt) => void opened.push([ws, prompt]) });
    expect(isIceboxed(readState().workspaces.calm)).toBe(false);
    expect(opened).toEqual([["calm", THAW_PROMPT]]);
    expect(() => thaw("calm", { open: () => {} })).toThrow("not iceboxed");
  });

  test("a thawed tab continues the conversation and reads the handoff", () => {
    expect(newTabKdl("calm", ["ob"], { resume: true, prompt: THAW_PROMPT })).toContain('"--continue" "--" "/read-handoff"');
  });
});

describe("opt-in reclaim", () => {
  /** A workspace with a committed `keep/tracked.txt`, an ignored `node_modules` and an `overbridge.yml` listing both. */
  function seeded(ws: string, branch: string): string {
    ob(["new", ws, "-r", "app"]);
    ob(["checkout", "app", branch, "--ws", ws]);
    const wt = join(root, ws, "app");
    mkdirSync(join(wt, "keep"), { recursive: true });
    writeFileSync(join(wt, "keep", "tracked.txt"), "t");
    writeFileSync(join(wt, ".gitignore"), "node_modules/\n");
    writeFileSync(join(wt, "overbridge.yml"), "version: 1\nicebox:\n  prune: [node_modules, keep, missing]\n");
    sh(["git", "add", "-A"], wt);
    sh(["git", "commit", "-q", "-m", "seed"], wt);
    sh(["git", "push", "-q", "origin", branch], wt);
    mkdirSync(join(wt, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(wt, "node_modules", "dep", "i.js"), "x");
    return wt;
  }

  test("prune is off unless the flag is passed", async () => {
    const wt = seeded("lazy", "feat/lazy");
    await icebox("lazy", {}, fakeDeps("").deps);
    expect(existsSync(join(wt, "node_modules"))).toBe(true);
    expect(existsSync(join(root, "lazy", "app"))).toBe(true);
    expect(readState().workspaces.lazy!.iceboxed?.dropped).toBeUndefined();
  });

  test("--prune deletes configured untracked paths and keeps tracked files", async () => {
    const wt = seeded("tidy", "feat/tidy");
    await icebox("tidy", { prune: true }, fakeDeps("").deps);
    expect(existsSync(join(wt, "node_modules"))).toBe(false);
    expect(readFileSync(join(wt, "keep", "tracked.txt"), "utf8")).toBe("t");
  });

  test("prunable refuses tracked paths and symlinks out of the repo", () => {
    const wt = join(root, "tidy", "app");
    expect(prunable(wt, "keep")).toEqual({ ok: false, why: "tracked by git" });
    expect(prunable(wt, "missing")).toEqual({ ok: false, why: "not there" });
    mkdirSync(join(tmp, "sub"), { recursive: true });
    symlinkSync(tmp, join(wt, "out"));
    expect(prunable(wt, "out/sub")).toEqual({ ok: false, why: "outside the repo" });
  });

  test("--drop-worktree removes the worktree, keeps the claim and branch, and thaw recreates it", async () => {
    const wt = seeded("drop", "feat/drop");
    rmSync(join(wt, "node_modules"), { recursive: true });
    await icebox("drop", { dropWorktree: true }, fakeDeps("").deps);
    expect(existsSync(wt)).toBe(false);
    const w = readState().workspaces.drop!;
    expect(w.iceboxed?.dropped).toEqual(["app"]);
    expect(w.repos.app?.branch).toBe("feat/drop");
    expect(icedRows(readState(), 40).join("\n")).toContain("drop iceboxed · dropped");
    const opened: string[] = [];
    thaw("drop", { open: (ws) => void opened.push(ws) });
    expect(sh(["git", "branch", "--show-current"], wt)).toBe("feat/drop");
    expect(readFileSync(join(wt, "keep", "tracked.txt"), "utf8")).toBe("t");
    expect(isIceboxed(readState().workspaces.drop)).toBe(false);
    expect(opened).toEqual(["drop"]);
  });

  test("--drop-worktree refuses unpushed work and removes nothing", async () => {
    const wt = seeded("risky", "feat/risky");
    rmSync(join(wt, "node_modules"), { recursive: true });
    sh(["git", "commit", "-q", "--allow-empty", "-m", "local only"], wt);
    await expect(icebox("risky", { dropWorktree: true }, fakeDeps("").deps)).rejects.toThrow("unpushed");
    expect(existsSync(wt)).toBe(true);
    expect(isIceboxed(readState().workspaces.risky)).toBe(false);
  });

  test("thaw refuses, staying iceboxed, when a dropped worktree's folder is taken", async () => {
    const wt = seeded("taken", "feat/taken");
    rmSync(join(wt, "node_modules"), { recursive: true });
    await icebox("taken", { dropWorktree: true }, fakeDeps("").deps);
    mkdirSync(wt, { recursive: true });
    expect(() => thaw("taken", { open: () => {} })).toThrow("already exists");
    expect(isIceboxed(readState().workspaces.taken)).toBe(true);
  });
});

describe("asking for an iceboxed workspace's tab", () => {
  test("thaws it instead of opening a tab beside the mark", () => {
    withState((st) => {
      st.workspaces.calm!.iceboxed = { since: new Date().toISOString() };
    });
    showTab("calm");
    expect(isIceboxed(readState().workspaces.calm)).toBe(false);
  });
});

describe("stopChecksFor", () => {
  test("kills the running command's group and drops only that workspace's tickets", async () => {
    const dir = join(tmp, "queue");
    mkdirSync(dir, { recursive: true });
    const child = Bun.spawn(["sleep", "60"], { detached: true } as never);
    const ticket = (ws: string, extra: Partial<Ticket> = {}): Ticket => ({ pid: 999_999, ws, repo: "app", command: "x", queuedAtMs: Date.now(), ...extra });
    const mine = ticket("calm", { runPid: child.pid });
    const other = ticket("other", { queuedAtMs: Date.now() + 1 });
    writeFileSync(join(dir, ticketName(mine)), JSON.stringify(mine));
    writeFileSync(join(dir, ticketName(other)), JSON.stringify(other));
    expect(stopChecksFor("calm", dir)).toBe(1);
    await child.exited;
    expect(existsSync(join(dir, ticketName(mine)))).toBe(false);
    expect(existsSync(join(dir, ticketName(other)))).toBe(true);
    expect(queueDir()).toContain("check-queue");
  });
});
