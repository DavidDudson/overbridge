import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allExtensions, extensionDirs, extensionFiles, renderExtensions } from "../src/ext";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
let tmp: string;
let root: string;
let team: string;
let repo: string;

function put(file: string, text: string) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-ext-")));
  root = join(tmp, "workspaces");
  team = join(tmp, "team-ext");
  repo = join(root, "w1", "app");
  put(join(team, "all", "prose.md"), "Use Australian English.\n");
  put(join(team, "ship-pr", "pr-body.md"), "Add a Jira link.\n");
  put(join(team, "ship-pr", "notes.txt"), "ignored");
  put(join(repo, ".overbridge", "ext", "ship-pr", "pr-body.md"), "This repo wants screenshots.\n");
  put(join(root, "local-ext", "ship-pr", "post-pr.md"), "Move the ticket.\n");
  put(join(root, "config.yml"), `skill-extensions:\n  - ${team}\n  - local-ext\n  - ~/nowhere\n`);
  Bun.spawnSync({ cmd: ["git", "init", "-q", repo] });
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("extensionDirs", () => {
  test("expands ~ and root-relative dirs, then adds the repo's own dir", () => {
    const saved = process.env.OVERBRIDGE_ROOT;
    process.env.OVERBRIDGE_ROOT = root;
    try {
      expect(extensionDirs(repo, ["/abs", "~/x", "rel"], "/home/u")).toEqual(["/abs", "/home/u/x", join(root, "rel"), join(repo, ".overbridge", "ext")]);
      expect(extensionDirs(undefined, [], "/home/u")).toEqual([]);
    } finally {
      saved === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = saved);
    }
  });
});

describe("extensionFiles", () => {
  const dirs = () => [team, join(repo, ".overbridge", "ext")];

  test("reads all/<phase> then <skill>/<phase> from each dir, least specific first", () => {
    expect(extensionFiles("ship-pr", "pr-body", dirs())).toEqual([join(team, "ship-pr", "pr-body.md"), join(repo, ".overbridge", "ext", "ship-pr", "pr-body.md")]);
    expect(extensionFiles("ship-pr", "prose", dirs())).toEqual([join(team, "all", "prose.md")]);
    expect(extensionFiles("all", "prose", dirs())).toEqual([join(team, "all", "prose.md")]);
    expect(extensionFiles("start-item", "plan", dirs())).toEqual([]);
  });

  test("refuses names that could leave the dir", () => {
    expect(() => extensionFiles("../x", "p", dirs())).toThrow("invalid skill name");
    expect(() => extensionFiles("s", "../../p", dirs())).toThrow("invalid phase name");
  });

  test("renders each file under a comment naming it", () => {
    expect(renderExtensions([join(team, "all", "prose.md")])).toBe(`<!-- overbridge ext: ${join(team, "all", "prose.md")} -->\nUse Australian English.\n`);
    expect(renderExtensions([])).toBe("");
  });

  test("allExtensions lists markdown files only, skipping missing dirs", () => {
    expect(allExtensions([team, join(tmp, "missing")]).map((e) => `${e.skill} ${e.phase}`)).toEqual(["all prose", "ship-pr pr-body"]);
  });
});

describe("overbridge ext", () => {
  const ob = (args: string[], cwd = repo) => {
    const p = Bun.spawnSync({
      cmd: [process.execPath, CLI, "ext", ...args],
      cwd,
      env: { ...process.env, OVERBRIDGE_ROOT: root, HOME: tmp },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };

  test("prints the root config's extensions and the repo's own, in order", () => {
    const r = ob(["ship-pr", "pr-body"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      `<!-- overbridge ext: ${join(team, "ship-pr", "pr-body.md")} -->\nAdd a Jira link.\n\n` +
        `<!-- overbridge ext: ${join(repo, ".overbridge", "ext", "ship-pr", "pr-body.md")} -->\nThis repo wants screenshots.\n`,
    );
    expect(ob(["ship-pr", "post-pr"]).out).toContain("Move the ticket.");
  });

  test("prints nothing when a phase has no extensions, and lists every file", () => {
    expect(ob(["start-item", "plan"])).toEqual({ code: 0, out: "", err: "" });
    expect(ob(["list"]).out.split("\n").filter(Boolean).map((l) => l.split("\t")[0])).toEqual([
      "all prose",
      "ship-pr pr-body",
      "ship-pr post-pr",
      "ship-pr pr-body",
    ]);
  });

  test("outside a repo only the root config's dirs count", () => {
    expect(ob(["ship-pr", "pr-body"], tmp).out).not.toContain("screenshots");
  });

  test("usage", () => {
    const r = ob(["ship-pr"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("usage: overbridge ext <skill> <phase>");
  });
});
