import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "../src/project-config";

/** The message `parseConfig` throws for `yaml`, without the file-name header. */
function problems(yaml: string): string[] {
  try {
    parseConfig(yaml, "f.yml");
  } catch (e) {
    return (e as Error).message
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && l !== "f.yml:");
  }
  throw new Error("expected the config to be rejected");
}

const app = (extra: string) => `apps:\n  - id: a\n    start: x\n${extra}`;

describe("config validation messages", () => {
  test("each problem names its key path", () => {
    expect(problems("version: 2\n")).toEqual(["version: unsupported version 2 (this overbridge reads version 1)"]);
    expect(problems("ide: emacs\n")).toEqual(['ide: expected one of vscode, zed, webstorm (got "emacs")']);
    expect(problems("project-management:\n  name: trello\n  project: x\n")).toEqual([
      'project-management.name: expected one of github, jira (got "trello")',
    ]);
    expect(problems("project-management:\n  name: github\n")).toEqual(["project-management.project: required"]);
    expect(problems("review:\n  personas: security\n")).toEqual(["review.personas: expected a list of strings"]);
  });

  test("a file that is not a mapping says so", () => {
    expect(() => parseConfig("- a\n", "f.yml")).toThrow("f.yml: expected a mapping at the top level");
  });

  test("a typo gets a suggestion, a stranger lists the allowed keys", () => {
    expect(problems("commands:\n  tset: x\n")).toEqual(["commands.tset: unknown key, did you mean 'test'?"]);
    expect(problems("commands:\n  deploy: x\n")).toEqual([
      "commands.deploy: unknown key (allowed: lint, typecheck, test, build, format)",
    ]);
  });

  test("app errors carry the list index", () => {
    expect(problems("apps:\n  - id: a\n")).toEqual(["apps[0].start: required"]);
    expect(problems("apps:\n  - id: a\n    start: x\n  - id: a\n    start: y\n")).toEqual(["apps[1].id: duplicate app id 'a'"]);
    expect(problems(app("    prot: [1]\n"))).toEqual([
      "apps[0].prot: unknown key (allowed: id, label, dir, start, stop, prepare, ports, ready, open, when)",
    ]);
  });

  test("app ports, when and ready are checked", () => {
    expect(problems(app("    ports: [0, 70000]\n"))).toEqual(["apps[0].ports: expected a list of ports (1-65535)"]);
    expect(problems(app("    when: never\n"))).toEqual(['apps[0].when: expected one of always, feature-branch (got "never")']);
    expect(problems(app("    ready: { http: 'http://x', tcp: 1 }\n"))).toEqual(["apps[0].ready: set exactly one of http or tcp"]);
    expect(problems(app("    ready: { ftp: x }\n"))).toEqual([
      "apps[0].ready.ftp: unknown key, did you mean 'http'?",
      "apps[0].ready: set exactly one of http or tcp",
    ]);
  });

  test("an app id cannot reach outside the app's files", () => {
    for (const id of ["../x", "a/b", ".", "..", "a b", ".hidden"]) {
      const out = problems(`apps:\n  - id: ${JSON.stringify(id)}\n    start: x\n`);
      expect(out).toHaveLength(1);
      expect(out[0]).toStartWith("apps[0].id: ");
      expect(out[0]).toContain("must start with a letter or digit");
    }
    for (const id of ["web", "web-2", "db_1", "api.v2", "9lives"]) {
      expect(() => parseConfig(`apps:\n  - id: ${id}\n    start: x\n`, "f.yml")).not.toThrow();
    }
  });

  test("every problem is reported at once", () => {
    const out = problems("ide: emacs\nversion: 3\ncommands:\n  tset: x\n");
    expect(out).toHaveLength(3);
  });
});

describe("shipped example", () => {
  test("overbridge.example.yml is valid and exercises every top-level key", () => {
    const text = readFileSync(join(import.meta.dir, "..", "overbridge.example.yml"), "utf8");
    const config = parseConfig(text, "overbridge.example.yml");
    expect(config.projectManagement?.name).toBe("github");
    expect(config.apps.map((a) => a.id)).toEqual(["web"]);
    expect(Object.keys(config.commands).sort()).toEqual(["build", "format", "lint", "test", "typecheck"]);
    expect(config.ide).toBe("vscode");
  });
});
