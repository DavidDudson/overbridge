import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadRepoConfig, parseConfig, suggest } from "../src/project-config";

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

  test("accepts a numeric GitHub project number", () => {
    expect(parseConfig("project-management: { name: github, project: 4 }").projectManagement?.project).toBe("4");
  });

  test("rejects unknown keys with a suggestion", () => {
    const m = err("project-managment: { name: github, project: x }");
    expect(m).toContain("overbridge.yml");
    expect(m).toContain("project-managment: unknown key, did you mean 'project-management'?");
  });

  test("lists allowed keys when nothing is close", () => {
    expect(err("zzzzzzzzzz: 1")).toContain("allowed: version, project-management, apps, ide");
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

  test("invalid YAML names the file", () => {
    expect(err("a: [unclosed")).toContain("overbridge.yml: invalid YAML");
  });
});

describe("loadRepoConfig", () => {
  test("missing file means defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "overbridge-cfg-"));
    try {
      expect(loadRepoConfig(dir)).toEqual(defaultConfig());
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "overbridge.yml"), "ide: vscode\n");
      expect(loadRepoConfig(dir).ide).toBe("vscode");
    } finally {
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
