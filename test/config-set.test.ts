import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentRefusal, configSet, inlineYaml, type KeySchema, parseConfigValue, setYamlValue, unknownKeyProblem } from "../src/config-set";
import { parseYaml, rootConfigPath } from "../src/project-config";
import { isRecord, type Json } from "../src/util";

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

  test("knows every mapping key in overbridge.example.yml as a defaults key", () => {
    const keyPaths = (node: Json, path: string[]): string[][] =>
      isRecord(node) ? Object.entries(node).flatMap(([key, child]) => [[...path, key], ...keyPaths(child, [...path, key])]) : [];

    const example = parseYaml(readFileSync(join(import.meta.dir, "..", "overbridge.example.yml"), "utf8"), "overbridge.example.yml");
    const problems = keyPaths(example, ["defaults"]).flatMap((path) => unknownKeyProblem(path, ROOT, LAYER) ?? []);

    expect(problems).toEqual([]);
  });

  test("refuses an unknown guard key", () => {
    expect(problem("guard.allow")).toStartWith("unknown key 'allow' under guard");
  });
});

describe("agentRefusal", () => {
  test.each<[Record<string, string>, string | undefined, boolean]>([
    [{ CLAUDECODE: "1" }, "ws1", true],
    [{ CLAUDECODE: "1", OVERBRIDGE_TAB: "@root" }, undefined, true],
    [{}, "ws1", false],
    [{ CLAUDECODE: "1" }, undefined, false],
    [{ CLAUDECODE: "1" }, "", false],
    [{}, undefined, false],
  ])("%p in workspace %p refused: %p", (env, workspace, refused) => {
    expect(agentRefusal(env, workspace) !== undefined).toBe(refused);
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
    ["bun test # fast", "bun test # fast"],
    ["echo a: b", "echo a: b"],
    ["- x", "- x"],
    ["1.10", "1.10"],
    ["null", null],
    ["yes", "yes"],
    ["~", "~"],
    ["Null", "Null"],
    ["[a, b", "[a, b"],
    ["false", false],
    ["-5", -5],
    ["1e3", "1e3"],
    ['"5"', "5"],
    ["'true'", "true"],
    ['"a" "b"', '"a" "b"'],
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

  test("keeps a comment after a plain value holding a quote", () => {
    expect(setYamlValue("commands:\n  test: echo don't # keep\n", ["commands", "test"], "t")).toBe("commands:\n  test: t # keep\n");
  });

  test("keeps a comment after a quoted value holding a #", () => {
    expect(setYamlValue('ide: "a # b" # keep\n', ["ide"], "zed")).toBe("ide: zed # keep\n");
    expect(setYamlValue("ide: 'it''s # x' # keep\n", ["ide"], "zed")).toBe("ide: zed # keep\n");
    expect(setYamlValue('orgs: ["a # b", c] # keep\n', ["orgs"], ["d"])).toBe('orgs: ["d"] # keep\n');
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

  test("edits past an indentless list", () => {
    expect(setYamlValue("skill-extensions:\n- a\ndefaults:\n  ide: vscode\n", ["defaults", "ide"], "zed")).toBe("skill-extensions:\n- a\ndefaults:\n  ide: zed\n");
    expect(setYamlValue("defaults:\n  mcp-servers:\n  - a\n", ["defaults", "ide"], "zed")).toBe("defaults:\n  mcp-servers:\n  - a\n  ide: zed\n");
  });

  test("adds keys below the comments of a file with no keys", () => {
    expect(setYamlValue("# managed by me\n", ["defaults", "ide"], "zed")).toBe("# managed by me\ndefaults:\n  ide: zed\n");
  });

  test("refuses CRLF line endings", () => {
    expect(() => setYamlValue("defaults:\r\n  ide: vscode\r\n", ["defaults", "ide"], "zed")).toThrow("CRLF");
  });

  test("refuses to edit through a list", () => {
    expect(() => setYamlValue("defaults:\n  - a\n", ["defaults", "ide"], "zed")).toThrow("defaults is a list, not a block mapping");
  });

  test("refuses a file with more than one document", () => {
    expect(() => setYamlValue("a: 1\n---\nb: 2\n", ["a"], 2)).toThrow("more than one YAML document");
  });

  test("refuses an edit that would change another key, such as one that drops an anchor an alias uses", () => {
    expect(() => setYamlValue("defaults:\n  ide: &e vscode\nrepos:\n  web:\n    ide: *e\n", ["defaults", "ide"], "zed")).toThrow(
      "without changing other keys",
    );
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

  test("leaves the file alone when the editor refuses", () => {
    const yaml = "defaults:\n  ide: &e vscode\nrepos:\n  web:\n    ide: *e\n";
    writeFileSync(rootConfigPath(), yaml);
    expect(() => configSet("defaults.ide", "zed")).toThrow("without changing other keys");
    expect(readFileSync(rootConfigPath(), "utf8")).toBe(yaml);
  });

  test("writes through a symlinked config.yml", () => {
    const target = join(tmp, "real.yml");
    writeFileSync(target, "version: 1\n");
    symlinkSync(target, rootConfigPath());
    configSet("defaults.ide", "zed");
    expect(lstatSync(rootConfigPath()).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("version: 1\ndefaults:\n  ide: zed\n");
  });

  test("says nothing was written when validation fails", () => {
    expect(() => configSet("defaults.ide", "emacs")).toThrow("not written:");
  });

  test("reports a repos.toml it cannot read and still writes", () => {
    writeFileSync(join(tmp, "repos.toml"), "not = [toml");
    const messages: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((msg: string) => messages.push(msg));

    try {
      configSet("ide", "zed", "web");
    } finally {
      spy.mockRestore();
    }

    expect(messages.some((msg) => msg.includes("could not read repos.toml"))).toBe(true);
    expect(messages.some((msg) => msg.includes("is not in repos.toml"))).toBe(false);
    expect(readFileSync(rootConfigPath(), "utf8")).toBe("repos:\n  web:\n    ide: zed\n");
  });

  test("keeps the file's mode", () => {
    writeFileSync(rootConfigPath(), "version: 1\n");
    chmodSync(rootConfigPath(), 0o600);
    configSet("defaults.ide", "zed");
    expect(statSync(rootConfigPath()).mode & 0o777).toBe(0o600);
  });

  test("refuses a key the schema does not know before touching the file", () => {
    expect(() => configSet("defaults.idee", "zed")).toThrow("did you mean 'ide'?");
    expect(existsSync(rootConfigPath())).toBe(false);
  });
});
