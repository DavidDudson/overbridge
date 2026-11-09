import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configCheck, configGet } from "../src/commands";
import { repoOf } from "../src/paths";
import {
  getConfigValue,
  loadRepoConfig,
  loadRootLayers,
  overlay,
  parseConfig,
  resolveConfig,
  rootConfigPath,
} from "../src/project-config";

let tmp: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.OVERBRIDGE_ROOT;
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-root-config-")));
  process.env.OVERBRIDGE_ROOT = tmp;
});

afterEach(() => {
  saved === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = saved);
  rmSync(tmp, { recursive: true, force: true });
});

const writeRoot = (yaml: string) => writeFileSync(rootConfigPath(), yaml);

/** A worktree `<root>/<ws>/<repo>`, with `yaml` as its overbridge.yml when given. */
function worktree(ws: string, repo: string, yaml?: string): string {
  const dir = join(tmp, ws, repo);
  mkdirSync(dir, { recursive: true });
  if (yaml !== undefined) writeFileSync(join(dir, "overbridge.yml"), yaml);
  return dir;
}

const thrown = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a throw");
};

describe("overlay", () => {
  test("mappings merge, lists and scalars replace, null removes", () => {
    const base = { a: { x: 1, y: 2 }, list: [1, 2], keep: "k", drop: "d" };
    const over = { a: { y: 3, z: 4 }, list: [9], drop: null };
    expect(overlay(base, over)).toEqual({ a: { x: 1, y: 3, z: 4 }, list: [9], keep: "k" });
  });

  test("a missing or empty layer leaves the base alone", () => {
    expect(overlay({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(overlay({ a: 1 }, null)).toEqual({ a: 1 });
    expect(overlay(undefined, { a: 1 })).toEqual({ a: 1 });
  });
});

describe("loadRootLayers", () => {
  test("a missing or empty file has no layers", () => {
    expect(loadRootLayers()).toEqual({ file: rootConfigPath(), repos: {}, skillExtensions: [], guard: { readPaths: [], deny: [] } });
    writeRoot("");
    expect(loadRootLayers()).toEqual({ file: rootConfigPath(), repos: {}, skillExtensions: [], guard: { readPaths: [], deny: [] } });
  });

  test("reads defaults and per-repo layers", () => {
    writeRoot("version: 1\ndefaults:\n  ide: zed\nrepos:\n  app:\n    commands:\n      test: bun test\n  empty: ~\n");
    expect(loadRootLayers()).toEqual({
      file: rootConfigPath(),
      defaults: { ide: "zed" },
      repos: { app: { commands: { test: "bun test" } } },
      skillExtensions: [],
      guard: { readPaths: [], deny: [] },
    });
  });

  test("reports bad top-level keys and shapes together", () => {
    writeRoot("version: 2\ndefault:\n  ide: zed\nrepos:\n  app: 3\n");
    const message = thrown(() => loadRootLayers());
    expect(message).toContain("version: unsupported version 2");
    expect(message).toContain("default: unknown key, did you mean 'defaults'?");
    expect(message).toContain("repos.app: expected a mapping in overbridge.yml's format");
  });

  test("a non-mapping file, defaults or repos is rejected", () => {
    writeRoot("- a\n");
    expect(thrown(() => loadRootLayers())).toContain("expected a mapping at the top level");
    writeRoot("defaults: 3\nrepos: [a]\n");
    const message = thrown(() => loadRootLayers());
    expect(message).toContain("defaults: expected a mapping");
    expect(message).toContain("repos: expected a mapping of repo name to settings");
  });

  test("checks each layer on its own, naming where a problem is, but allows partial layers", () => {
    writeRoot("defaults:\n  project-management:\n    url: https://example.atlassian.net\n");
    expect(loadRootLayers().defaults).toBeDefined();
    writeRoot("defaults:\n  comands: {}\n");
    expect(thrown(() => loadRootLayers())).toContain("config.yml (defaults):\n  comands: unknown key, did you mean 'commands'?");
    writeRoot("repos:\n  app:\n    ide: emacs\n");
    expect(thrown(() => loadRootLayers())).toContain("config.yml (repos.app):\n  ide: expected one of");
  });
});

describe("resolveConfig", () => {
  test("defaults < repo file < repos.<name>", () => {
    writeRoot(
      [
        "defaults:",
        "  ide: zed",
        "  commands: { test: default-test, lint: default-lint }",
        "repos:",
        "  app:",
        "    commands: { lint: root-lint }",
        "  other:",
        "    ide: webstorm",
      ].join("\n"),
    );
    const config = loadRepoConfig(worktree("ws1", "app", "ide: vscode\ncommands:\n  test: repo-test\n  lint: repo-lint\n"));
    expect(config.ide).toBe("vscode");
    expect(config.commands).toEqual({ test: "repo-test", lint: "root-lint" });
  });

  test("a repo with no overbridge.yml gets its settings from the root config", () => {
    writeRoot("repos:\n  app:\n    project-management:\n      name: jira\n      project: ENG\n");
    expect(loadRepoConfig(worktree("ws1", "app")).projectManagement).toEqual({ name: "jira", project: "ENG" });
  });

  test("a root layer can complete or remove what the repo file sets", () => {
    writeRoot("repos:\n  app:\n    project-management:\n      url: https://example.atlassian.net\n    ide: ~\n");
    const config = loadRepoConfig(worktree("ws1", "app", "ide: zed\nproject-management:\n  name: jira\n  project: ENG\n"));
    expect(config.projectManagement).toEqual({ name: "jira", project: "ENG", url: "https://example.atlassian.net" });
    expect(config.ide).toBeUndefined();
  });

  test("outside a workspace only the defaults apply", () => {
    writeRoot("defaults:\n  ide: zed\nrepos:\n  app:\n    ide: webstorm\n");
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-outside-")));
    try {
      expect(loadRepoConfig(join(outside, "app")).ide).toBe("zed");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("an incomplete merge names every file that went into it", () => {
    writeRoot("defaults:\n  project-management:\n    name: jira\n");
    const message = thrown(() => resolveConfig({ ide: "zed" }, "app", "overbridge.yml"));
    expect(message).toContain(`${rootConfigPath()} (defaults) + overbridge.yml:`);
    expect(message).toContain("project-management.project: required");
  });

  test("a problem in the repo file names the repo file", () => {
    expect(thrown(() => resolveConfig({ ide: "emacs" }, "app", "app/overbridge.yml"))).toContain("app/overbridge.yml:\n  ide:");
  });
});

describe("extension keys", () => {
  test("x-* keys pass validation and read back as written", () => {
    const config = parseConfig("x-acme:\n  squad: Platform\n  jira-fields:\n    story-points: customfield_1\n");
    expect(config.extensions).toEqual({ "x-acme": { squad: "Platform", "jira-fields": { "story-points": "customfield_1" } } });
    expect(getConfigValue(config, "x-acme.squad")).toBe("Platform");
    expect(getConfigValue(config, "x-acme.jira-fields.story-points")).toBe("customfield_1");
    expect(getConfigValue(config, "x-acme.missing")).toBeUndefined();
    expect(getConfigValue(config, "x-other")).toBeUndefined();
  });

  test("a config with no x-* keys has no extensions", () => {
    expect(parseConfig("ide: zed\n").extensions).toBeUndefined();
  });

  test("x-* keys merge across layers", () => {
    writeRoot("defaults:\n  x-acme: { squad: A, sprint: S }\nrepos:\n  app:\n    x-acme: { squad: B }\n");
    const config = loadRepoConfig(worktree("ws1", "app"));
    expect(getConfigValue(config, "x-acme")).toEqual({ squad: "B", sprint: "S" });
  });

  test("only top-level x-* keys are extensions", () => {
    expect(() => parseConfig("commands:\n  x-deploy: x\n")).toThrow("commands.x-deploy: unknown key");
  });
});

describe("repoOf", () => {
  test("names the repo of a worktree path, and nothing outside one", () => {
    expect(repoOf(join(tmp, "ws1", "app"))).toBe("app");
    expect(repoOf(join(tmp, "ws1", "app", "src", "x.ts"))).toBe("app");
    expect(repoOf(join(tmp, "ws1"))).toBeUndefined();
    expect(repoOf(join(tmp, ".bare", "app.git"))).toBeUndefined();
    expect(repoOf(join(tmp, "ws1", ".claude"))).toBeUndefined();
    expect(repoOf(tmp)).toBeUndefined();
    expect(repoOf("/elsewhere/app")).toBeUndefined();
  });
});

describe("config commands", () => {
  const captured = (fn: () => void) => {
    const out: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    console.error = (...a: unknown[]) => void out.push(a.join(" "));
    try {
      fn();
    } finally {
      console.log = log;
      console.error = error;
    }
    return out.join("\n");
  };

  test("config get reads through the root layers", () => {
    writeRoot("repos:\n  app:\n    commands: { test: root-test }\n    x-acme: { squad: B }\n");
    const dir = worktree("ws1", "app");
    expect(captured(() => configGet("commands.test", dir))).toBe("root-test");
    expect(captured(() => configGet("x-acme.squad", dir))).toBe("B");
  });

  test("config check covers the repo file and the root config, or the root config alone", () => {
    writeRoot("defaults:\n  ide: zed\n");
    const dir = worktree("ws1", "app", "commands: { test: t }\n");
    expect(captured(() => configCheck(dir))).toContain(`${join(dir, "overbridge.yml")} + ${rootConfigPath()}: ok`);
    expect(captured(() => configCheck(rootConfigPath()))).toContain(`${rootConfigPath()}: ok`);
    expect(captured(() => configCheck(worktree("ws1", "bare")))).toContain(`${rootConfigPath()}: ok`);
  });

  test("config check fails when neither file exists", () => {
    expect(() => configCheck(worktree("ws1", "app"))).toThrow("does not exist");
    expect(() => configCheck(rootConfigPath())).toThrow("does not exist");
  });
});

describe("skill-extensions", () => {
  test("is a list of directories", () => {
    writeRoot("skill-extensions: [~/ext, /abs]\n");
    expect(loadRootLayers().skillExtensions).toEqual(["~/ext", "/abs"]);
    writeRoot("skill-extensions: ~/ext\n");
    expect(thrown(() => loadRootLayers())).toContain("skill-extensions: expected a list of strings");
  });
});

describe("buttons in the root config", () => {
  test("are checked for shape, ids and actions", () => {
    writeRoot(
      [
        "defaults:",
        "  buttons:",
        "    - { id: a, label: A, run: x, url: y }",
        "    - { id: a, label: B, run: x }",
        "    - { id: 'bad id', label: C, run: x, side: up }",
        "    - 3",
      ].join("\n"),
    );
    const message = thrown(() => loadRootLayers());
    expect(message).toContain("buttons[0]: set run or url, not both");
    expect(message).toContain("buttons[1].id: duplicate button id 'a'");
    expect(message).toContain("buttons[2].id: 'bad id' must start with a letter or digit");
    expect(message).toContain('buttons[2].side: expected one of left, right (got "up")');
    expect(message).toContain("buttons[3]: expected a mapping");
    writeRoot("repos:\n  app:\n    buttons: x\n");
    expect(thrown(() => loadRootLayers())).toContain("config.yml (repos.app):\n  buttons: expected a list");
  });

  test("a merged button needs something to do", () => {
    writeRoot("defaults:\n  buttons:\n    - { id: a, label: A }\n");
    expect(thrown(() => loadRepoConfig(worktree("ws1", "app")))).toContain("buttons[0]: set run, url or status");
  });

  test("reach the repo's resolved config", () => {
    writeRoot("repos:\n  app:\n    buttons:\n      - { id: docs, label: Docs, run: make docs, side: left }\n");
    expect(loadRepoConfig(worktree("ws1", "app")).buttons).toEqual([{ id: "docs", label: "Docs", run: "make docs", side: "left" }]);
  });
});

describe("guard block", () => {
  test("reads read-paths and compiles deny patterns", () => {
    writeRoot("guard:\n  read-paths: [~/seeds]\n  deny:\n    - pattern: '\\bnpm publish\\b'\n      reason: no publishing\n");
    const { guard } = loadRootLayers();
    expect(guard.readPaths).toEqual(["~/seeds"]);
    expect(guard.deny.map((d) => [d.pattern.source, d.reason])).toEqual([["\\bnpm publish\\b", "no publishing"]]);
  });

  test("reports bad keys, rules and patterns", () => {
    writeRoot("guard:\n  read-path: [x]\n  deny:\n    - pattern: '('\n      reason: r\n    - reason: r\n    - 3\n");
    const message = thrown(() => loadRootLayers());
    expect(message).toContain("guard.read-path: unknown key, did you mean 'read-paths'?");
    expect(message).toContain("guard.deny[0].pattern: not a valid regular expression");
    expect(message).toContain("guard.deny[1].pattern: required");
    expect(message).toContain("guard.deny[2]: expected a mapping with pattern and reason");
    writeRoot("guard: [x]\n");
    expect(thrown(() => loadRootLayers())).toContain("guard: expected a mapping");
    writeRoot("guard:\n  deny: x\n");
    expect(thrown(() => loadRootLayers())).toContain("guard.deny: expected a list");
  });

  test("a repo's overbridge.yml can't loosen the guard", () => {
    expect(() => parseConfig("guard:\n  read-paths: [/]\n")).toThrow("guard: unknown key");
  });
});

describe("guard hook", () => {
  const CLI = join(import.meta.dir, "..", "src", "cli.ts");
  const guard = (input: object) => {
    const p = Bun.spawnSync({
      cmd: [process.execPath, CLI, "guard"],
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      env: { ...process.env, OVERBRIDGE_ROOT: tmp, OVERBRIDGE_NAME: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: p.exitCode, err: p.stderr.toString() };
  };
  const call = (command: string) => ({ cwd: worktree("ws1", "app"), tool_name: "Bash", tool_input: { command } });

  test("applies the root config's deny rules", () => {
    writeRoot("guard:\n  deny:\n    - pattern: '\\bnpm publish\\b'\n      reason: no publishing from a workspace\n");
    expect(guard(call("npm publish"))).toEqual({ code: 2, err: "overbridge guard: no publishing from a workspace\n" });
    expect(guard(call("npm test")).code).toBe(0);
  });

  test("a root config that can't be read blocks everything", () => {
    writeRoot("guard: [x]\n");
    const r = guard(call("npm test"));
    expect(r.code).toBe(2);
    expect(r.err).toContain("internal error, blocking to be safe");
  });
});
