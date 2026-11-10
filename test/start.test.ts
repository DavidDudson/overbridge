import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkout, createWorkspace, repoAdd } from "../src/commands";
import { openTab, start } from "../src/start";
import { readState } from "../src/state";
import type { RunResult } from "../src/util";
import { fakeProvider } from "./helpers/fake-provider";

let tmp: string;
const saved = { ...process.env };

const sh = (cmd: string[], cwd: string) => {
  const p = Bun.spawnSync({ cmd, cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr}`);
};

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "overbridge-start-"));
  Object.assign(process.env, {
    OVERBRIDGE_ROOT: join(tmp, "workspaces"),
    OVERBRIDGE_NAME: "",
    ZELLIJ: "",
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
  repoAdd("app", join(tmp, "remote.git"));
});

afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(tmp, { recursive: true, force: true });
});

const provider = () => fakeProvider([{ id: "12", title: "Add dark mode", url: "" }]);

describe("start", () => {
  test("creates a workspace named for the item, on the item's branch", () => {
    start("app", "12", undefined, { provider: provider() });
    const w = readState().workspaces["gh-app-12"]!;
    expect(w.repos.app?.branch).toBe("feat/12-add-dark-mode");
    expect(existsSync(join(tmp, "workspaces", "gh-app-12", "app", ".git"))).toBe(true);
    expect(existsSync(join(tmp, "workspaces", "gh-app-12", ".claude", "settings.json"))).toBe(true);
  });

  test("an item that already has a workspace is not started twice", () => {
    start("app", "12", undefined, { provider: provider() });
    expect(Object.keys(readState().workspaces)).toEqual(["gh-app-12"]);
  });

  test("a refused claim leaves no workspace behind", () => {
    const p = fakeProvider([{ id: "13", title: "Other", url: "" }]);
    createWorkspace("holder", ["app"]);
    checkout(["app", "feat/13-other"], "holder");
    expect(() => start("app", "13", undefined, { provider: p })).toThrow("claimed by workspace holder");
    expect(readState().workspaces["gh-app-13"]).toBeUndefined();
    expect(existsSync(join(tmp, "workspaces", "gh-app-13"))).toBe(false);
  });

  test("an unknown item is an error", () => {
    expect(() => start("app", "99", undefined, { provider: provider() })).toThrow("99: not found");
  });
});

/** A fake zellij: `current-tab-info` names `current` (or fails when undefined), `new-tab` succeeds when `opens`. */
const fakeZellij = (current: string | undefined, opens = true) => {
  const calls: string[][] = [];
  const exec = (cmd: string[]): RunResult => {
    calls.push(cmd);
    const action = cmd[2];
    if (action === "current-tab-info") {
      return { ok: current !== undefined, code: current === undefined ? 1 : 0, stdout: current === undefined ? "" : `name: ${current}\nposition: 0`, stderr: "" };
    }
    if (action === "new-tab") {
      return { ok: opens, code: opens ? 0 : 1, stdout: opens ? "3" : "", stderr: opens ? "" : "no session" };
    }
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  return { calls, exec, actions: () => calls.map((c) => c[2]) };
};

describe("start inside zellij", () => {
  beforeAll(() => {
    process.env.ZELLIJ = "0";
  });
  afterAll(() => {
    process.env.ZELLIJ = "";
  });

  test("a new workspace's tab opens in the background", () => {
    const z = fakeZellij("mine");
    start("app", "20", undefined, { provider: fakeProvider([{ id: "20", title: "Background", url: "" }]), exec: z.exec });
    expect(z.actions()).toEqual(["current-tab-info", "new-tab", "go-to-tab-name"]);
    expect(z.calls[1]).toContain("gh-app-20");
    expect(z.calls[2]).toEqual(["zellij", "action", "go-to-tab-name", "mine"]);
  });

  test("an item that already has a workspace switches to its tab", () => {
    const z = fakeZellij("mine");
    start("app", "20", undefined, { provider: fakeProvider([{ id: "20", title: "Background", url: "" }]), exec: z.exec });
    expect(z.calls[0]).toEqual(["zellij", "action", "go-to-tab-name", "gh-app-20"]);
    expect(z.actions()).not.toContain("new-tab");
  });

  test("no current tab means nothing to go back to", () => {
    const z = fakeZellij(undefined);
    openTab("ws-a", undefined, z.exec);
    expect(z.actions()).toEqual(["current-tab-info", "new-tab"]);
  });

  test("a tab that fails to open does not move focus", () => {
    const z = fakeZellij("mine", false);
    openTab("ws-b", undefined, z.exec);
    expect(z.actions()).toEqual(["current-tab-info", "new-tab"]);
  });
});
