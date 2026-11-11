import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkout, createWorkspace, newWorkspace, repoAdd } from "../src/commands";
import { metaDir } from "../src/paths";
import { localStacks } from "../src/stack";
import { showTab, start, startStack, startTask } from "../src/start";
import { readState, withState } from "../src/state";
import { zellijMux } from "../src/mux";
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
    // A workspace being removed still holds its claim but is not one to switch to, so the claim is refused.
    withState((s) => {
      s.workspaces.holder!.removing = { since: new Date().toISOString(), pid: process.pid };
    });
    try {
      expect(() => start("app", "13", undefined, { provider: p, plugins: noProblems })).toThrow("claimed by workspace holder");
    } finally {
      withState((s) => {
        delete s.workspaces.holder!.removing;
      });
    }
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

describe("start --stack", () => {
  const items = [
    { id: "31", title: "Base layer", url: "" },
    { id: "32", title: "Middle layer", url: "" },
    { id: "33", title: "Top layer", url: "" },
  ];
  const stackProvider = () => fakeProvider(items);
  const BRANCHES = ["feat/31-base-layer", "feat/32-middle-layer", "feat/33-top-layer"];
  const wtOf = (ws: string) => join(tmp, "workspaces", ws, "app");
  const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync({ cmd: ["git", ...args], cwd, env: process.env, stdout: "pipe" });
    return p.stdout.toString().trim();
  };
  const ghStack = () => Bun.spawnSync({ cmd: ["gh", "stack", "--version"], stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  const stackTest = ghStack() ? test : test.skip;

  stackTest("one workspace, a layer per item bottom first, claim and HEAD on the bottom", () => {
    startStack("app", ["31", "32", "33"], {}, { provider: stackProvider(), plugins: noProblems });
    const w = readState().workspaces["gh-app-31-stack"]!;
    expect(w.repos.app?.branch).toBe(BRANCHES[0]);
    expect(git(wtOf("gh-app-31-stack"), "branch", "--show-current")).toBe(BRANCHES[0]!);
    const stack = localStacks("app").find((s) => s.layers.some((l) => l.branch === BRANCHES[0]))!;
    expect(stack.layers.map((l) => l.branch)).toEqual(BRANCHES);
    // each layer sits on the one below it
    const isAncestor = (a: string, b: string) =>
      Bun.spawnSync({ cmd: ["git", "merge-base", "--is-ancestor", a, b], cwd: wtOf("gh-app-31-stack") }).exitCode === 0;
    expect(isAncestor(BRANCHES[0]!, BRANCHES[1]!)).toBe(true);
    expect(isAncestor(BRANCHES[1]!, BRANCHES[2]!)).toBe(true);
  });

  stackTest("the claim covers every layer: another workspace cannot take a middle or top one", () => {
    createWorkspace("rival", ["app"]);
    for (const b of BRANCHES.slice(1)) {
      expect(() => checkout(["app", b], "rival")).toThrow("claimed by workspace gh-app-31-stack");
    }
  });

  stackTest("an existing stack workspace is not started twice", () => {
    startStack("app", ["31", "32", "33"], {}, { provider: stackProvider(), plugins: noProblems });
    expect(Object.keys(readState().workspaces).filter((n) => n.endsWith("-stack"))).toEqual(["gh-app-31-stack"]);
  });

  stackTest("a layer claimed elsewhere refuses the whole start and leaves nothing behind", () => {
    const p = fakeProvider([
      { id: "41", title: "A", url: "" },
      { id: "42", title: "B", url: "" },
    ]);
    checkout(["app", "feat/42-b"], "rival");
    expect(() => startStack("app", ["41", "42"], {}, { provider: p, plugins: noProblems })).toThrow("claimed by workspace rival");
    expect(readState().workspaces["gh-app-41-stack"]).toBeUndefined();
    expect(git(join(tmp, "remote.git"), "branch", "--list", "feat/41-a")).toBe("");
  });

  stackTest("--name sets the workspace name", () => {
    const p = fakeProvider([
      { id: "51", title: "A", url: "" },
      { id: "52", title: "B", url: "" },
    ]);
    startStack("app", ["51", "52"], { name: "perf-one" }, { provider: p, plugins: noProblems });
    expect(readState().workspaces["perf-one"]?.repos.app?.branch).toBe("feat/51-a");
  });

  test("fewer than two items, a repeated id, a missing item or a bad name is an error and creates nothing", () => {
    const run = (ids: string[], name?: string) => startStack("app", ids, { name }, { provider: stackProvider(), plugins: noProblems, ghStack: () => true });
    expect(() => run(["31"])).toThrow("at least two items");
    expect(() => run(["31", "31"])).toThrow("listed twice");
    expect(() => run(["31", "99"])).toThrow("99: not found");
    expect(() => run(["31", "32"], "../x")).toThrow("invalid workspace name");
    expect(Object.keys(readState().workspaces)).not.toContain("../x");
  });

  test("missing gh-stack stops before anything is created", () => {
    expect(() =>
      startStack("app", ["61", "62"], {}, { provider: fakeProvider(), plugins: noProblems, ghStack: () => false }),
    ).toThrow("gh-stack is not installed");
    expect(readState().workspaces["gh-app-61-stack"]).toBeUndefined();
  });
});

/**
 * A fake zellij:`current-tab-info` names `current` (or fails when undefined), `new-tab` succeeds when `opens`,
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
  return { calls, exec, mux: zellijMux(exec), actions: () => calls.map((c) => c[2]) };
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
    start("app", "20", undefined, { provider: fakeProvider([{ id: "20", title: "Background", url: "" }]), mux: z.mux, plugins: noProblems });
    expect(z.actions()).toEqual(["current-tab-info", "new-tab", "go-to-tab-name"]);
    expect(z.calls[1]).toContain("gh-app-20");
    expect(z.calls[2]).toEqual(["zellij", "action", "go-to-tab-name", "mine"]);
  });

  test("an item that already has a workspace switches to its tab", () => {
    const z = fakeZellij("mine", true, ["mine", "gh-app-20"]);
    start("app", "20", undefined, { provider: fakeProvider([{ id: "20", title: "Background", url: "" }]), mux: z.mux, plugins: noProblems });
    expect(z.actions()).toEqual(["query-tab-names", "go-to-tab-name"]);
    expect(z.calls[1]).toEqual(["zellij", "action", "go-to-tab-name", "gh-app-20"]);
  });

  test("no current tab means nothing to go back to", () => {
    const z = fakeZellij(undefined);
    openTab("ws-a", undefined, TabFocus.Background, z.mux);
    expect(z.actions()).toEqual(["current-tab-info", "new-tab"]);
  });

  test("a tab that fails to open does not move focus", () => {
    const z = fakeZellij("mine", false);
    openTab("ws-b", undefined, TabFocus.Background, z.mux);
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
    start("app", "12", undefined, { provider: provider(), mux: z.mux, plugins: noProblems });
    expect(z.actions()).toEqual(["query-tab-names", "new-tab"]);
    expect(z.calls[1]).toContain("gh-app-12");
    expect(tabLayout("gh-app-12")).toContain("/start-item 12");
  });

  test("start on a workspace with no tab opens one running the given prompt", () => {
    const z = fakeZellij("mine");
    start("app", "12", "fix the build", { provider: provider(), mux: z.mux, plugins: noProblems });
    expect(z.actions()).toEqual(["query-tab-names", "new-tab"]);
    expect(tabLayout("gh-app-12")).toContain("fix the build");
  });

  test("start on a workspace whose tab is open switches to it", () => {
    captureLog();
    const z = fakeZellij("mine", true, ["mine", "gh-app-12"]);
    start("app", "12", undefined, { provider: provider(), mux: z.mux, plugins: noProblems });
    expect(z.actions()).toEqual(["query-tab-names", "go-to-tab-name"]);
    expect(errors.some((e) => e.includes("prompt not sent"))).toBe(false);
  });

  test("start with --prompt on a workspace whose tab is open says the prompt was not sent", () => {
    captureLog();
    const z = fakeZellij("mine", true, ["mine", "gh-app-12"]);
    start("app", "12", "fix the build", { provider: provider(), mux: z.mux, plugins: noProblems });
    expect(z.actions()).not.toContain("new-tab");
    expect(errors).toContain("gh-app-12 already has a tab; prompt not sent");
  });

  test("new opens the workspace's tab in the background with a bare agent", () => {
    const z = fakeZellij("mine");
    newWorkspace("fresh", [], z.mux);
    expect(z.actions()).toEqual(["current-tab-info", "new-tab", "go-to-tab-name"]);
    expect(z.calls[1]).toContain("fresh");
    expect(tabLayout("fresh")).toContain('"claude" "fresh"\n');
  });

  test("showTab reopens a closed tab in front with the prompt", () => {
    const z = fakeZellij("mine", true, ["mine"]);
    showTab("fresh", { prompt: "carry on" }, z.mux);
    expect(z.actions()).toEqual(["query-tab-names", "new-tab"]);
    expect(tabLayout("fresh")).toContain("carry on");
  });
});

describe("start inside a task workspace", () => {
  const wt = (ws: string) => join(tmp, "workspaces", ws, "app");
  const out = (cmd: string[], cwd: string) => Bun.spawnSync({ cmd, cwd, env: process.env, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
  const hasBranch = (ws: string, branch: string) => out(["git", "branch", "--list", branch], wt(ws)) !== "";
  const commit = (ws: string, file: string) => {
    writeFileSync(join(wt(ws), file), file);
    sh(["git", "add", "."], wt(ws));
    sh(["git", "commit", "-qm", file], wt(ws));
  };
  const items = () =>
    fakeProvider([
      { id: "70", title: "Carry", url: "" },
      { id: "71", title: "Kept", url: "" },
      { id: "72", title: "Other", url: "" },
      { id: "73", title: "Fresh", url: "" },
      { id: "74", title: "Dirty", url: "" },
    ]);
  /** Run `fn` as the workspace's own Claude would: with `OVERBRIDGE_NAME` set. */
  const inside = (ws: string, fn: () => void) => {
    process.env.OVERBRIDGE_NAME = ws;
    try {
      fn();
    } finally {
      process.env.OVERBRIDGE_NAME = "";
    }
  };
  let errors: string[];
  let spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errors = [];
    spy = spyOn(console, "error").mockImplementation((msg: string) => {
      errors.push(msg);
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  test("re-binds the task workspace to the item, carrying its commits and uncommitted work", () => {
    startTask("app", "spike-a", "spike it", { plugins: noProblems });
    commit("spike-a", "spike.txt");
    writeFileSync(join(wt("spike-a"), "wip.txt"), "wip");
    const before = Object.keys(readState().workspaces);

    inside("spike-a", () => start("app", "70", undefined, { provider: items(), plugins: noProblems }));

    expect(Object.keys(readState().workspaces)).toEqual(before);
    expect(readState().workspaces["spike-a"]!.repos.app?.branch).toBe("feat/70-carry");
    expect(out(["git", "branch", "--show-current"], wt("spike-a"))).toBe("feat/70-carry");
    expect(out(["git", "log", "--oneline"], wt("spike-a"))).toContain("spike.txt");
    expect(existsSync(join(wt("spike-a"), "wip.txt"))).toBe(true);
    expect(hasBranch("spike-a", "task/spike-a")).toBe(false);
    expect(errors.some((e) => e.includes("deleted task/spike-a"))).toBe(true);
    expect(errors.some((e) => e.includes("spike-a/app now on 70"))).toBe(true);
  });

  test("keeps the task branch when the item branch already exists without its commits", () => {
    startTask("app", "spike-b", "spike it", { plugins: noProblems });
    sh(["git", "push", "-q", "origin", "HEAD:refs/heads/feat/71-kept"], wt("spike-b"));
    commit("spike-b", "only-here.txt");

    inside("spike-b", () => start("app", "71", undefined, { provider: items(), plugins: noProblems }));

    expect(readState().workspaces["spike-b"]!.repos.app?.branch).toBe("feat/71-kept");
    expect(hasBranch("spike-b", "task/spike-b")).toBe(true);
    expect(errors.some((e) => e.includes("kept task/spike-b"))).toBe(true);
  });

  test("a claim that is not a task branch still starts the item's own workspace", () => {
    createWorkspace("busy", ["app"]);
    checkout(["app", "feat/other-work"], "busy");

    inside("busy", () => start("app", "72", undefined, { provider: items(), plugins: noProblems }));

    expect(readState().workspaces["gh-app-72"]?.repos.app?.branch).toBe("feat/72-other");
    expect(readState().workspaces["busy"]!.repos.app?.branch).toBe("feat/other-work");
  });

  test("--here re-binds a clean workspace on a fresh branch and keeps the old one", () => {
    createWorkspace("clean", ["app"]);
    checkout(["app", "feat/clean-work"], "clean");

    inside("clean", () => start("app", "73", undefined, { provider: items(), plugins: noProblems, here: true }));

    expect(readState().workspaces["clean"]!.repos.app?.branch).toBe("feat/73-fresh");
    expect(readState().workspaces["gh-app-73"]).toBeUndefined();
    expect(hasBranch("clean", "feat/clean-work")).toBe(true);
  });

  test("--here refuses a workspace with uncommitted changes and changes nothing", () => {
    createWorkspace("dirty", ["app"]);
    checkout(["app", "feat/dirty-work"], "dirty");
    writeFileSync(join(wt("dirty"), "wip.txt"), "wip");

    expect(() => inside("dirty", () => start("app", "74", undefined, { provider: items(), plugins: noProblems, here: true }))).toThrow(
      "uncommitted changes or unpushed commits",
    );

    expect(readState().workspaces["dirty"]!.repos.app?.branch).toBe("feat/dirty-work");
    expect(readState().workspaces["gh-app-74"]).toBeUndefined();
  });

  test("an item some workspace already claims by branch gets that workspace's tab, not a new workspace", () => {
    process.env.ZELLIJ = "0";
    try {
      const z = fakeZellij("mine", true, ["mine", "spike-a"]);
      start("app", "70", undefined, { provider: items(), mux: z.mux, plugins: noProblems });
      expect(z.actions()).toEqual(["query-tab-names", "go-to-tab-name"]);
      expect(z.calls[1]).toEqual(["zellij", "action", "go-to-tab-name", "spike-a"]);
      expect(readState().workspaces["gh-app-70"]).toBeUndefined();
      expect(errors.some((e) => e.includes("70 is in spike-a"))).toBe(true);
    } finally {
      process.env.ZELLIJ = "";
    }
  });
});
