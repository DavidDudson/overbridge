import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkout, createWorkspace, newWorkspace, repoAdd } from "../src/commands";
import { metaDir } from "../src/paths";
import { showTab, start, startTask } from "../src/start";
import { readState } from "../src/state";
import { openTab, TabFocus } from "../src/tab";
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

const noProblems = () => ({ errors: [], warnings: [] });
const provider = () => fakeProvider([{ id: "12", title: "Add dark mode", url: "" }]);

describe("start", () => {
  test("creates a workspace named for the item, on the item's branch", () => {
    start("app", "12", undefined, { provider: provider(), plugins: noProblems });
    const w = readState().workspaces["gh-app-12"]!;
    expect(w.repos.app?.branch).toBe("feat/12-add-dark-mode");
    expect(existsSync(join(tmp, "workspaces", "gh-app-12", "app", ".git"))).toBe(true);
    expect(existsSync(join(tmp, "workspaces", "gh-app-12", ".claude", "settings.json"))).toBe(true);
  });

  test("an item that already has a workspace is not started twice", () => {
    start("app", "12", undefined, { provider: provider(), plugins: noProblems });
    expect(Object.keys(readState().workspaces)).toEqual(["gh-app-12"]);
  });

  test("a refused claim leaves no workspace behind", () => {
    const p = fakeProvider([{ id: "13", title: "Other", url: "" }]);
    createWorkspace("holder", ["app"]);
    checkout(["app", "feat/13-other"], "holder");
    expect(() => start("app", "13", undefined, { provider: p, plugins: noProblems })).toThrow("claimed by workspace holder");
    expect(readState().workspaces["gh-app-13"]).toBeUndefined();
    expect(existsSync(join(tmp, "workspaces", "gh-app-13"))).toBe(false);
  });

  test("a missing plugin bundle stops the start before any workspace exists", () => {
    const plugins = () => ({ errors: ["marketplace.json is missing"], warnings: [] });
    expect(() => start("app", "12", undefined, { provider: provider(), plugins })).toThrow("marketplace.json is missing");
    expect(() => start("app", "13", undefined, { provider: provider(), plugins })).toThrow("/start-item would be unknown");
    expect(readState().workspaces["gh-app-13"]).toBeUndefined();
  });

  test("an unknown item is an error", () => {
    expect(() => start("app", "99", undefined, { provider: provider(), plugins: noProblems })).toThrow("99: not found");
  });
});

/**
 * A fake zellij: `current-tab-info` names `current` (or fails when undefined), `new-tab` succeeds when `opens`,
 * and `query-tab-names` lists `tabs`.
 */
const fakeZellij = (current: string | undefined, opens = true, tabs: string[] = []) => {
  const calls: string[][] = [];
  const exec = (cmd: string[]): RunResult => {
    calls.push(cmd);
    const action = cmd[2];
    if (action === "query-tab-names") {
      return { ok: true, code: 0, stdout: tabs.join("\n"), stderr: "" };
    }
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
    start("app", "20", undefined, { provider: fakeProvider([{ id: "20", title: "Background", url: "" }]), exec: z.exec, plugins: noProblems });
    expect(z.actions()).toEqual(["current-tab-info", "new-tab", "go-to-tab-name"]);
    expect(z.calls[1]).toContain("gh-app-20");
    expect(z.calls[2]).toEqual(["zellij", "action", "go-to-tab-name", "mine"]);
  });

  test("an item that already has a workspace switches to its tab", () => {
    const z = fakeZellij("mine", true, ["mine", "gh-app-20"]);
    start("app", "20", undefined, { provider: fakeProvider([{ id: "20", title: "Background", url: "" }]), exec: z.exec, plugins: noProblems });
    expect(z.actions()).toEqual(["query-tab-names", "go-to-tab-name"]);
    expect(z.calls[1]).toEqual(["zellij", "action", "go-to-tab-name", "gh-app-20"]);
  });

  test("no current tab means nothing to go back to", () => {
    const z = fakeZellij(undefined);
    openTab("ws-a", undefined, TabFocus.Background, z.exec);
    expect(z.actions()).toEqual(["current-tab-info", "new-tab"]);
  });

  test("a tab that fails to open does not move focus", () => {
    const z = fakeZellij("mine", false);
    openTab("ws-b", undefined, TabFocus.Background, z.exec);
    expect(z.actions()).toEqual(["current-tab-info", "new-tab"]);
  });
});

describe("start --task", () => {
  test("creates a workspace named for the task, on a claimed task/<slug> branch", () => {
    startTask("app", "file-ticket", "file a ticket for X", { plugins: noProblems });
    const w = readState().workspaces["file-ticket"]!;
    expect(w.repos.app?.branch).toBe("task/file-ticket");
    expect(existsSync(join(tmp, "workspaces", "file-ticket", ".claude", "settings.json"))).toBe(true);
  });

  test("a task that already has a workspace is not started twice", () => {
    const before = Object.keys(readState().workspaces).length;
    startTask("app", "file-ticket", "file a ticket for X", { plugins: noProblems });
    expect(Object.keys(readState().workspaces).length).toBe(before);
  });

  test("an invalid slug is an error and creates nothing", () => {
    expect(() => startTask("app", "../escape", "x", { plugins: noProblems })).toThrow("invalid task name");
    expect(() => startTask("app", "@root", "x", { plugins: noProblems })).toThrow("invalid task name");
  });

  test("an empty prompt is an error", () => {
    expect(() => startTask("app", "no-prompt", "  ", { plugins: noProblems })).toThrow("needs --prompt");
    expect(readState().workspaces["no-prompt"]).toBeUndefined();
  });

  test("a task stops before any workspace exists when the plugins are missing", () => {
    const plugins = () => ({ errors: ["marketplace.json is missing"], warnings: [] });
    expect(() => startTask("app", "no-plugins", "x", { plugins })).toThrow("would not have the overbridge skills");
    expect(readState().workspaces["no-plugins"]).toBeUndefined();
  });

  test("a refused claim leaves no workspace behind", () => {
    checkout(["app", "task/taken"], "holder");
    expect(() => startTask("app", "taken", "x", { plugins: noProblems })).toThrow("claimed by workspace holder");
    expect(readState().workspaces["taken"]).toBeUndefined();
  });
});

const tabLayout = (ws: string) => readFileSync(join(metaDir(), "tabs", `${ws}.kdl`), "utf8");

describe("tabs", () => {
  let errors: string[];
  let spy: ReturnType<typeof spyOn>;

  beforeAll(() => {
    process.env.ZELLIJ = "0";
  });

  afterAll(() => {
    process.env.ZELLIJ = "";
  });

  const captureLog = () => {
    errors = [];
    spy = spyOn(console, "error").mockImplementation((msg: string) => {
      errors.push(msg);
    });
  };

  afterEach(() => {
    spy?.mockRestore();
  });

  test("start on a workspace with no tab opens one in front, running /start-item", () => {
    const z = fakeZellij("mine");
    start("app", "12", undefined, { provider: provider(), exec: z.exec, plugins: noProblems });
    expect(z.actions()).toEqual(["query-tab-names", "new-tab"]);
    expect(z.calls[1]).toContain("gh-app-12");
    expect(tabLayout("gh-app-12")).toContain("/start-item 12");
  });

  test("start on a workspace with no tab opens one running the given prompt", () => {
    const z = fakeZellij("mine");
    start("app", "12", "fix the build", { provider: provider(), exec: z.exec, plugins: noProblems });
    expect(z.actions()).toEqual(["query-tab-names", "new-tab"]);
    expect(tabLayout("gh-app-12")).toContain("fix the build");
  });

  test("start on a workspace whose tab is open switches to it", () => {
    captureLog();
    const z = fakeZellij("mine", true, ["mine", "gh-app-12"]);
    start("app", "12", undefined, { provider: provider(), exec: z.exec, plugins: noProblems });
    expect(z.actions()).toEqual(["query-tab-names", "go-to-tab-name"]);
    expect(errors.some((e) => e.includes("prompt not sent"))).toBe(false);
  });

  test("start with --prompt on a workspace whose tab is open says the prompt was not sent", () => {
    captureLog();
    const z = fakeZellij("mine", true, ["mine", "gh-app-12"]);
    start("app", "12", "fix the build", { provider: provider(), exec: z.exec, plugins: noProblems });
    expect(z.actions()).not.toContain("new-tab");
    expect(errors).toContain("gh-app-12 already has a tab; prompt not sent");
  });

  test("new opens the workspace's tab in the background with a bare agent", () => {
    const z = fakeZellij("mine");
    newWorkspace("fresh", [], z.exec);
    expect(z.actions()).toEqual(["current-tab-info", "new-tab", "go-to-tab-name"]);
    expect(z.calls[1]).toContain("fresh");
    expect(tabLayout("fresh")).toContain('"claude" "fresh"\n');
  });

  test("showTab reopens a closed tab in front with the prompt", () => {
    const z = fakeZellij("mine", true, ["mine"]);
    showTab("fresh", { prompt: "carry on" }, z.exec);
    expect(z.actions()).toEqual(["query-tab-names", "new-tab"]);
    expect(tabLayout("fresh")).toContain("carry on");
  });
});
