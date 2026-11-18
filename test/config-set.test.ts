import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSet, inlineYaml, type KeySchema, parseConfigValue, setYamlValue, unknownKeyProblem } from "../src/config-set";
import { rootConfigPath } from "../src/project-config";
import type { Json } from "../src/util";

// SAFETY: both files are the JSON Schema documents the package ships.
const schema = (name: string): KeySchema => JSON.parse(readFileSync(join(import.meta.dir, "..", name), "utf8")) as KeySchema;
const ROOT = schema("config.schema.json");
const LAYER = schema("overbridge.schema.json");
const problem = (key: string) => unknownKeyProblem(key.split("."), ROOT, LAYER);

describe("unknownKeyProblem", () => {
  test.each([
    "defaults.ide",
    "defaults.commands.test",
    "defaults.hooks.post-add",
    "defaults.check-queue.max-parallel",
    "repos.web.ide",
    "owners.DavidDudson.review.ship-pr",
    "defaults.x-acme.squad.name",
    "defaults.project-management.branch-types.Bug",
    "guard.read-paths",
    "github-orgs",
    "version",
  ])("knows %s", (key) => {
    expect(problem(key)).toBeUndefined();
  });

  test("refuses an unknown top-level key with a suggestion", () => {
    expect(problem("defualts.ide")).toBe("unknown key 'defualts' (did you mean 'defaults'?)");
  });

  test("refuses an unknown layer key with a suggestion", () => {
    expect(problem("defaults.idee")).toBe("unknown key 'idee' under defaults (did you mean 'ide'?)");
  });

  test("refuses a key under a scalar", () => {
    expect(problem("defaults.ide.name")).toBe("unknown key 'name' under defaults.ide");
  });

  test("refuses an extension key at the root, where the schema allows none", () => {
    expect(problem("x-acme.squad")).toStartWith("unknown key 'x-acme'");
  });

  test("refuses an unknown guard key", () => {
    expect(problem("guard.allow")).toStartWith("unknown key 'allow' under guard");
  });
});

describe("parseConfigValue", () => {
  test.each<[string, Json]>([
    ["zed", "zed"],
    ["5", 5],
    ["true", true],
    ["[a, b]", ["a", "b"]],
    ["{ test: bun test }", { test: "bun test" }],
    ["nix develop --command", "nix develop --command"],
    ["", ""],
    ["a: b: c", "a: b: c"],
  ])("%p", (text, value) => {
    expect(parseConfigValue(text)).toEqual(value);
  });
});

describe("inlineYaml", () => {
  test.each<[Json, string]>([
    ["zed", "zed"],
    ["bun test", "bun test"],
    ["true", '"true"'],
    ["5", '"5"'],
    ["a # b", '"a # b"'],
    ["a: b", '"a: b"'],
    ["", '""'],
    [5, "5"],
    [false, "false"],
    [["a", "b"], '["a","b"]'],
    [null, "null"],
  ])("%p", (value, yaml) => {
    expect(inlineYaml(value)).toBe(yaml);
  });
});

describe("setYamlValue", () => {
  const FILE = `# root config
version: 1

defaults:
  # the editor every repo opens in
  ide: vscode   # change me
  commands:
    test: bun test

repos:
  web:
    ide: webstorm
# trailing note
`;

  test("replaces a value, keeping its comment and every other line", () => {
    expect(setYamlValue(FILE, ["defaults", "ide"], "zed")).toBe(FILE.replace("ide: vscode   # change me", "ide: zed   # change me"));
  });

  test("adds a key at the end of its mapping", () => {
    expect(setYamlValue(FILE, ["defaults", "commands", "lint"], "oxlint")).toBe(FILE.replace("    test: bun test\n", "    test: bun test\n    lint: oxlint\n"));
  });

  test("adds the missing mappings on the way to a new key", () => {
    expect(setYamlValue(FILE, ["repos", "api", "check-queue", "max-parallel"], 2)).toBe(
      FILE.replace("    ide: webstorm\n", "    ide: webstorm\n  api:\n    check-queue:\n      max-parallel: 2\n"),
    );
  });

  test("adds a top-level key before trailing comments", () => {
    expect(setYamlValue(FILE, ["github-orgs"], ["acme"])).toBe(FILE.replace("# trailing note\n", 'github-orgs: ["acme"]\n# trailing note\n'));
  });

  test("replaces a block value with a scalar, dropping its old lines", () => {
    expect(setYamlValue(FILE, ["defaults", "commands"], { lint: "x" })).toBe(FILE.replace("  commands:\n    test: bun test\n", '  commands: {"lint":"x"}\n'));
  });

  test("writes into an empty or null mapping", () => {
    expect(setYamlValue("defaults:\nrepos: ~ # none yet\n", ["repos", "web", "ide"], "zed")).toBe("defaults:\nrepos: # none yet\n  web:\n    ide: zed\n");
  });

  test("starts an empty file", () => {
    expect(setYamlValue("", ["defaults", "ide"], "zed")).toBe("defaults:\n  ide: zed\n");
  });

  test("follows the file's indent", () => {
    expect(setYamlValue("defaults:\n    ide: zed\n", ["defaults", "commands", "test"], "t")).toBe("defaults:\n    ide: zed\n    commands:\n        test: t\n");
  });

  test("matches quoted keys and quotes keys YAML would misread", () => {
    expect(setYamlValue('repos:\n  "web": {}\n', ["repos", "web", "ide"], "zed")).toBe('repos:\n  "web":\n    ide: zed\n');
    expect(setYamlValue("repos:\n", ["repos", "true", "ide"], "zed")).toBe('repos:\n  "true":\n    ide: zed\n');
  });

  test("keeps a document start marker", () => {
    expect(setYamlValue("---\ndefaults:\n  ide: vscode\n", ["defaults", "ide"], "zed")).toBe("---\ndefaults:\n  ide: zed\n");
  });

  test("refuses to edit through a flow mapping", () => {
    expect(() => setYamlValue("defaults: { ide: vscode }\n", ["defaults", "ide"], "zed")).toThrow("defaults is written inline");
  });

  test("refuses to edit through a list", () => {
    expect(() => setYamlValue("defaults:\n  - a\n", ["defaults", "ide"], "zed")).toThrow("defaults is not a block mapping");
  });

  test("refuses a file with more than one document", () => {
    expect(() => setYamlValue("a: 1\n---\nb: 2\n", ["a"], 2)).toThrow("more than one YAML document");
  });

  test("refuses an empty key segment", () => {
    expect(() => setYamlValue("", ["defaults", ""], 1)).toThrow("is not a key");
  });
});

describe("configSet", () => {
  let tmp: string;
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.OVERBRIDGE_ROOT;
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-config-set-")));
    process.env.OVERBRIDGE_ROOT = tmp;
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.OVERBRIDGE_ROOT;
    } else {
      process.env.OVERBRIDGE_ROOT = saved;
    }

    rmSync(tmp, { recursive: true, force: true });
  });

  test("creates config.yml and writes the value", () => {
    configSet("defaults.ide", "zed");
    expect(readFileSync(rootConfigPath(), "utf8")).toBe("defaults:\n  ide: zed\n");
  });

  test("--repo writes under repos.<name>", () => {
    writeFileSync(rootConfigPath(), "# keep\nversion: 1\n");
    configSet("ide", "zed", "web");
    expect(readFileSync(rootConfigPath(), "utf8")).toBe("# keep\nversion: 1\nrepos:\n  web:\n    ide: zed\n");
  });

  test("refuses a value validateConfig rejects and leaves the file alone", () => {
    writeFileSync(rootConfigPath(), "version: 1\n");
    expect(() => configSet("defaults.ide", "emacs")).toThrow("ide");
    expect(readFileSync(rootConfigPath(), "utf8")).toBe("version: 1\n");
  });

  test("refuses a key the schema does not know before touching the file", () => {
    expect(() => configSet("defaults.idee", "zed")).toThrow("did you mean 'ide'?");
    expect(existsSync(rootConfigPath())).toBe(false);
  });
});
