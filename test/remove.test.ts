import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentStateFile, EndReason, sessionEndedForGood } from "../src/agent-state";
import { createReaper } from "../src/auto-remove";
import { CleanupCause, CleanupOutcome } from "../src/cleanup-log";
import { beginRemoval, FINISH_FLAG, Landing, parseTabIds, type RemovalDeps } from "../src/remove";
import { cleanable, gitClean } from "../src/top";
import { entries, entryLines } from "../src/sidebar";
import { isRemoving, readState, REMOVING_GRACE_MS, watchState, withState, type WorkspaceState } from "../src/state";
import type { RunResult } from "../src/util";

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

/** Deps that record every zellij call and pretend to start a worker; `focused` is the tab zellij reports as current. */
function fakeDeps(listTabs: string, focused = "") {
  const calls: string[][] = [];
  const spawned: string[] = [];
  const deps: RemovalDeps = {
    exec: (cmd) => {
      calls.push(cmd);
      if (cmd[2] === "list-tabs") {
        return ok(listTabs);
      }
      return cmd[2] === "current-tab-info" && focused ? ok(`name: ${focused}\n`) : ok();
    },
    spawnWorker: (ws) => {
      spawned.push(ws);
      return process.pid;
    },
    inZellij: true,
  };
  return { deps, calls, spawned };
}

const markEmpty = (ws: string) => {
  mkdirSync(join(root, ".overbridge", "agent"), { recursive: true });
  writeFileSync(agentStateFile(ws), JSON.stringify({ state: "empty", at: Date.now() }));
};

async function until(check: () => boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await Bun.sleep(100);
  }
  return check();
}

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-remove-")));
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

describe("parseTabIds", () => {
  test("maps each tab name to its stable id, skipping the header", () => {
    const ids = parseTabIds("TAB_ID  POSITION  NAME\n0  0  @root\n2  1  75\n4  2  ENG 1 x\n");
    expect([...ids]).toEqual([["@root", "0"], ["75", "2"], ["ENG 1 x", "4"]]);
  });
});

describe("isRemoving", () => {
  const w = (removing?: WorkspaceState["removing"]): WorkspaceState => ({ created: "", repos: {}, ...(removing ? { removing } : {}) });
  const now = Date.parse("2026-01-01T00:00:00Z");
  test("unmarked is not removing", () => {
    expect(isRemoving(w(), now)).toBe(false);
  });
  test("a mark without a pid counts only within the grace period", () => {
    expect(isRemoving(w({ since: new Date(now - 1_000).toISOString() }), now)).toBe(true);
    expect(isRemoving(w({ since: new Date(now - REMOVING_GRACE_MS - 1).toISOString() }), now)).toBe(false);
  });
  test("a mark with a pid counts while that worker lives", () => {
    const old = new Date(now - 3_600_000).toISOString();
    expect(isRemoving(w({ since: old, pid: 7 }), now, () => true)).toBe(true);
    expect(isRemoving(w({ since: old, pid: 7 }), now, () => false)).toBe(false);
  });
});

describe("watchState", () => {
  test("fires soon after any state write, so every sidebar redraws together", async () => {
    let fired = 0;
    const stop = watchState(() => fired++, 10);
    try {
      withState(() => undefined);
      expect(await until(() => fired > 0, 2_000)).toBe(true);
    } finally {
      stop();
    }
  });
});

describe("beginRemoval", () => {
  test("marks the workspace, starts the worker, lands on the neighbour and closes the tab by id", () => {
    ob(["new", "b1", "-r", "app"]);
    ob(["new", "b2", "-r", "app"]);
    const { deps, calls, spawned } = fakeDeps("TAB_ID  POSITION  NAME\n0  0  @root\n3  1  b1\n5  2  b2\n");

    expect(beginRemoval("b1", { deps })).toBeUndefined();

    expect(spawned).toEqual(["b1"]);
    expect(readState().workspaces.b1!.removing?.pid).toBe(process.pid);
    expect(entries().map((e) => e.tab)).not.toContain("b1");
    expect(calls[0]).toEqual(["zellij", "action", "go-to-tab-name", "b2"]);
    expect(calls.at(-1)).toEqual(["zellij", "action", "close-tab-by-id", "3"]);
    expect(beginRemoval("b1", { deps })).toBe("b1 is already being removed");
  });

  test("lands on the tab the user came from when it is given", () => {
    ob(["new", "c1", "-r", "app"]);
    const { deps, calls } = fakeDeps("");
    beginRemoval("c1", { deps, previous: "b2" });
    expect(calls[0]).toEqual(["zellij", "action", "go-to-tab-name", "b2"]);
  });

  test("records what started the removal, for the cleanup log", () => {
    ob(["new", "m1", "-r", "app"]);
    markEmpty("m1");
    const { deps } = fakeDeps("");
    expect(beginRemoval("m1", { deps, cause: CleanupCause.Merged })).toBeUndefined();
    expect(readState().workspaces.m1!.removing?.cause).toBe(CleanupCause.Merged);
  });

  test("refuses an orchestration tab without touching zellij", () => {
    const { deps, calls, spawned } = fakeDeps("");
    expect(beginRemoval("@root", { deps })).toContain("orchestration tab");
    expect(spawned).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("refuses at once, without hiding anything, when a repo has uncommitted changes", () => {
    ob(["new", "d1", "-r", "app"]);
    writeFileSync(join(root, "d1", "app", "dirty.txt"), "x");
    const { deps, calls, spawned } = fakeDeps("");
    expect(beginRemoval("d1", { deps })).toContain("uncommitted changes or unpushed commits");
    expect(readState().workspaces.d1!.removing).toBeUndefined();
    expect(spawned).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("Landing.IfFocused closes another tab without pulling the user off theirs", () => {
    ob(["new", "g1", "-r", "app"]);
    const { deps, calls } = fakeDeps("TAB_ID  POSITION  NAME\n0  0  @root\n7  1  g1\n", "@root");
    expect(beginRemoval("g1", { deps, landing: Landing.IfFocused })).toBeUndefined();
    expect(calls.some((c) => c[2] === "go-to-tab-name")).toBe(false);
    expect(calls.at(-1)).toEqual(["zellij", "action", "close-tab-by-id", "7"]);
  });

  test("Landing.IfFocused still lands elsewhere when the removed tab has focus", () => {
    ob(["new", "g2", "-r", "app"]);
    const { deps, calls } = fakeDeps("TAB_ID  POSITION  NAME\n0  0  @root\n8  1  g2\n", "g2");
    expect(beginRemoval("g2", { deps, landing: Landing.IfFocused })).toBeUndefined();
    expect(calls.some((c) => c[2] === "go-to-tab-name")).toBe(true);
    expect(calls.at(-1)).toEqual(["zellij", "action", "close-tab-by-id", "8"]);
  });
});

describe("a session closed on purpose", () => {
  const endSession = (ws: string, reason: string) => {
    mkdirSync(join(root, ".overbridge", "agent"), { recursive: true });
    writeFileSync(agentStateFile(ws), JSON.stringify({ state: "end", at: Date.now(), reason }));
  };

  test("makes a clean workspace cleanable, without a PR", () => {
    ob(["new", "h1", "-r", "app"]);
    expect(cleanable("h1")).toBe(false);
    endSession("h1", EndReason.PromptInputExit);
    expect(cleanable("h1")).toBe(true);
  });

  test("any other end leaves it alone", () => {
    ob(["new", "h2", "-r", "app"]);
    endSession("h2", EndReason.Other);
    expect(cleanable("h2")).toBe(false);
  });

  test("unsaved work keeps it, until the work is gone", () => {
    ob(["new", "h3", "-r", "app"]);
    endSession("h3", EndReason.PromptInputExit);
    const wt = join(root, "h3", "app");
    writeFileSync(join(wt, "dirty.txt"), "x");
    expect(cleanable("h3")).toBe(false);
    sh(["git", "add", "dirty.txt"], wt);
    sh(["git", "commit", "-q", "-m", "wip"], wt);
    expect(cleanable("h3")).toBe(false);
    sh(["git", "reset", "-q", "--hard", "HEAD~1"], wt);
    expect(cleanable("h3")).toBe(true);
  });

  test("never makes an orchestration tab cleanable", () => {
    endSession("@root", EndReason.PromptInputExit);
    expect(cleanable("@root")).toBe(false);
  });

  test("the sidebar reaper removes it in the background and marks a dirty one", async () => {
    ob(["new", "i1", "-r", "app"]);
    ob(["new", "i2", "-r", "app"]);
    endSession("i1", EndReason.PromptInputExit);
    endSession("i2", EndReason.PromptInputExit);
    writeFileSync(join(root, "i2", "app", "dirty.txt"), "x");
    const realSpawn = (ws: string) => {
      const proc = Bun.spawn({ cmd: [process.execPath, CLI, "rm", ws, `--${FINISH_FLAG}`], cwd: tmp, env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
      proc.unref();
      return proc.pid;
    };
    const deps: RemovalDeps = { exec: () => ok(), spawnWorker: realSpawn, inZellij: false };
    const reap = createReaper({ endedForGood: sessionEndedForGood, gitClean, remove: (ws) => beginRemoval(ws, { landing: Landing.IfFocused, deps }), now: Date.now });

    const unsaved = reap(entries().filter((e) => e.tab === "i1" || e.tab === "i2"));

    expect([...unsaved]).toEqual(["i2"]);
    expect(entries().map((e) => e.tab)).not.toContain("i1");
    expect(await until(() => !readState().workspaces.i1)).toBe(true);
    expect(existsSync(join(root, "i1"))).toBe(false);
    expect(readState().workspaces.i2!.removing).toBeUndefined();
    expect(entryLines({ ...entries().find((e) => e.tab === "i2")!, unsaved: true }, 1, false, 80).at(-1)).toContain("ended · unsaved work");
  });
});

describe("the background worker", () => {
  /** The real worker: the CLI, detached, so it outlives this call like it outlives the closed tab. */
  const realSpawn = (ws: string) => {
    const proc = Bun.spawn({ cmd: [process.execPath, CLI, "rm", ws, `--${FINISH_FLAG}`], cwd: tmp, env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
    proc.unref();
    return proc.pid;
  };
  const noZellij = (): RemovalDeps => ({ exec: () => ok(), spawnWorker: realSpawn, inZellij: false });

  test("finishes the removal after the caller returns", async () => {
    ob(["new", "e1", "-r", "app"]);
    markEmpty("e1");
    expect(beginRemoval("e1", { deps: noZellij() })).toBeUndefined();
    expect(existsSync(join(root, "e1"))).toBe(true);
    expect(await until(() => !readState().workspaces.e1)).toBe(true);
    expect(existsSync(join(root, "e1"))).toBe(false);
    expect(readState().cleanups?.filter((c) => c.ws === "e1").map((c) => [c.outcome, c.cause])).toEqual([[CleanupOutcome.Removed, CleanupCause.Cleanup]]);
  });

  test("a failure brings the workspace back with the error on its card and nothing removed", async () => {
    ob(["new", "f1", "-r", "app"]);
    markEmpty("f1");
    writeFileSync(join(root, "config.yml"), "defaults:\n  hooks:\n    pre-remove: 'exit 1'\n");
    try {
      expect(beginRemoval("f1", { deps: noZellij() })).toBeUndefined();
      expect(await until(() => readState().workspaces.f1?.removeError !== undefined)).toBe(true);
    } finally {
      rmSync(join(root, "config.yml"));
    }
    const w = readState().workspaces.f1!;
    expect(w.removing).toBeUndefined();
    expect(w.removeError).toContain("pre-remove hook for f1/app failed");
    expect(existsSync(join(root, "f1", "app", ".git"))).toBe(true);
    const card = entries().find((e) => e.tab === "f1")!;
    expect(card.error).toContain("pre-remove");
    expect(entryLines(card, 1, false, 80).at(-1)).toContain("cleanup failed: a pre-remove hook");
    expect(readState().cleanups?.filter((c) => c.ws === "f1").map((c) => c.outcome)).toEqual([CleanupOutcome.Failed]);
  });

  test("a new Cleanup clears the old error", () => {
    const { deps } = fakeDeps("");
    beginRemoval("f1", { deps });
    expect(readState().workspaces.f1!.removeError).toBeUndefined();
    withState((s) => {
      const { removing: _, ...rest } = s.workspaces.f1!;
      s.workspaces.f1 = rest;
    });
  });
});
