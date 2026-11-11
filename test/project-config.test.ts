import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, getConfigValue, loadRepoConfig, parseConfig, suggest } from "../src/project-config";

const err = (yaml: string): string => {
  try {
    parseConfig(yaml, "overbridge.yml");
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected parseConfig to throw");
};

describe("parseConfig", () => {
  test("empty file gives defaults", () => {
    expect(parseConfig("")).toEqual(defaultConfig());
    expect(parseConfig("# only a comment\n")).toEqual(defaultConfig());
  });

  test("parses a full config", () => {
    const c = parseConfig(`
version: 1
project-management:
  name: jira
  project: ENG
  url: https://example.atlassian.net
apps:
  - id: web
    start: pnpm dev --port {port}
    ports: [3000, 3001]
ide: zed
`);
    expect(c.projectManagement).toEqual({ name: "jira", project: "ENG", url: "https://example.atlassian.net" });
    expect(c.apps).toHaveLength(1);
    expect(c.apps[0]!.ports).toEqual([3000, 3001]);
    expect(c.ide).toBe("zed");
  });

  test("parses project-management.tech-debt", () => {
    const pm = (yaml: string) => parseConfig(`project-management: { name: github, project: o/r${yaml} }`).projectManagement;
    expect(pm(", tech-debt: 42")?.techDebt).toBe("42");
    expect(pm(", tech-debt: 'label:debt'")?.techDebt).toBe("label:debt");
    expect(pm("")).not.toHaveProperty("techDebt");
  });

  test("accepts a numeric GitHub project number", () => {
    expect(parseConfig("project-management: { name: github, project: 4 }").projectManagement?.project).toBe("4");
  });

  test("rejects unknown keys with a suggestion", () => {
    const m = err("project-managment: { name: github, project: x }");
    expect(m).toContain("overbridge.yml");
    expect(m).toContain("project-managment: unknown key, did you mean 'project-management'?");
  });

  test("lists allowed keys when nothing is close", () => {
    expect(err("zzzzzzzzzz: 1")).toContain("allowed: version, project-management, apps, commands, review, ide");
  });

  test("names the key for a bad provider", () => {
    expect(err("project-management: { name: gitlab, project: x }")).toContain(
      'project-management.name: expected one of github, jira (got "gitlab")',
    );
  });

  test("reports every problem at once", () => {
    const m = err("project-management: { name: github }\nide: emacs\nversion: 2");
    expect(m).toContain("project-management.project: required");
    expect(m).toContain("ide: expected one of");
    expect(m).toContain("version: unsupported version 2");
  });

  test("validates apps", () => {
    const m = err("apps:\n  - id: a\n  - id: b\n    start: x\n    stat: y\n  - id: b\n    start: x");
    expect(m).toContain("apps[0].start: required");
    expect(m).toContain("apps[1].stat: unknown key, did you mean 'start'?");
    expect(m).toContain("apps[2].id: duplicate app id 'b'");
  });

  test("parses commands and review", () => {
    const c = parseConfig(`
commands:
  test: pnpm test
  format: pnpm format
review:
  personas: [security, naming]
  exclude: [pr-size]
  local-dir: .review
`);
    expect(c.commands).toEqual({ test: "pnpm test", format: "pnpm format" });
    expect(c.review).toEqual({ personas: ["security", "naming"], exclude: ["pr-size"], localDir: ".review" });
  });

  test("icebox.prune lists repo-relative paths and defaults to none", () => {
    expect(parseConfig("icebox: { prune: [node_modules, target/debug] }").icebox.prune).toEqual(["node_modules", "target/debug"]);
    expect(parseConfig("version: 1").icebox.prune).toEqual([]);
  });

  test("icebox.prune refuses paths that leave the repo or glob", () => {
    for (const bad of ["/etc", "../x", "a/../../x", ".", "*.o", "a[b]"]) {
      expect(err(`icebox: { prune: ["${bad}"] }`)).toContain("icebox.prune");
    }
    expect(err("icebox: { zap: 1 }")).toContain("icebox");
  });

  test("review defaults: auto-select personas, no excludes, standard local dir", () => {
    expect(parseConfig("review: {}").review).toEqual({ exclude: [], localDir: ".overbridge/personas" });
  });

  test("validates commands and review", () => {
    const m = err("commands:\n  tset: x\n  lint: ''\nreview:\n  personas: security\n  exclude: [a, 1]\n  dir: x");
    expect(m).toContain("commands.tset: unknown key, did you mean 'test'?");
    expect(m).toContain("commands.lint: expected a non-empty string");
    expect(m).toContain("review.personas: expected a list of strings");
    expect(m).toContain("review.exclude[1]: expected a non-empty string");
    expect(m).toContain("review.dir: unknown key");
    expect(err("commands: pnpm test")).toContain("commands: expected a mapping");
  });

  test("invalid YAML names the file", () => {
    expect(err("a: [unclosed")).toContain("overbridge.yml: invalid YAML");
  });
});

describe("loadRepoConfig", () => {
  test("missing file means defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "overbridge-cfg-"));
    const saved = process.env.OVERBRIDGE_ROOT;
    process.env.OVERBRIDGE_ROOT = join(dir, "no-root"); // keep a real root config.yml out of the test
    try {
      expect(loadRepoConfig(dir)).toEqual(defaultConfig());
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "overbridge.yml"), "ide: vscode\n");
      expect(loadRepoConfig(dir).ide).toBe("vscode");
    } finally {
      saved === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = saved);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("suggest", () => {
  test("finds near misses only", () => {
    expect(suggest("aps", ["apps", "ide"])).toBe("apps");
    expect(suggest("qqqqqq", ["apps", "ide"])).toBeUndefined();
  });
});

describe("getConfigValue", () => {
  const c = parseConfig("project-management: { name: github, project: o/r }\ncommands: { test: pnpm test }");
  test("reads dotted keys in file spelling", () => {
    expect(getConfigValue(c, "commands.test")).toBe("pnpm test");
    expect(getConfigValue(c, "project-management.name")).toBe("github");
    expect(getConfigValue(c, "review.local-dir")).toBe(".overbridge/personas");
    expect(getConfigValue(c, "review.exclude")).toEqual([]);
  });
  test("unset or missing paths are undefined", () => {
    expect(getConfigValue(c, "commands.build")).toBeUndefined();
    expect(getConfigValue(c, "nope.deeper")).toBeUndefined();
    expect(getConfigValue(c, "commands.test.deeper")).toBeUndefined();
  });
});
