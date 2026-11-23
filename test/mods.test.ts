import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentModsRefusal,
  defaultModName,
  installMod,
  isGitUrl,
  listModLines,
  listMods,
  ModSource,
  MODS_MARKETPLACE,
  modsDir,
  modsMarketplace,
  modsSettings,
  type ModsDeps,
  removeMod,
  updateMods,
} from "../src/mods";
import { root } from "../src/paths";
import { workspacePluginSettings } from "../src/plugins";
import { rootLayersFrom, parseYaml } from "../src/project-config";
import type { RunResult } from "../src/util";

const tmp = mkdtempSync(join(tmpdir(), "overbridge-mods-"));

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ok = (stdout = ""): RunResult => ({ ok: true, code: 0, stdout, stderr: "" });
const failed = (stderr: string): RunResult => ({ ok: false, code: 1, stdout: "", stderr });

/** A plugin folder with a named plugin.json; `bad` makes the fake validator reject it. */
function makePlugin(dir: string, name: string, opts: { version?: string; bad?: boolean } = {}) {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version: opts.version }));

  if (opts.bad) {
    writeFileSync(join(dir, "BAD"), "");
  }

  return dir;
}

/** A runner that clones by writing a plugin, validates by the BAD marker, and records every call. */
function fakeRunner(clone: (dest: string) => void = (dest) => makePlugin(dest, "cloned", { version: "1.0.0" })) {
  const calls: string[][] = [];

  const responses = new Map<string, RunResult>([
    ["git pull", ok("Already up to date.")],
    ["git remote", ok("https://example.test/me/cloned.git\n")],
    ["git rev-parse", ok("abc123\n")],
    ["git reset", ok()],
  ]);

  const run = (cmd: string[]): RunResult => {
    calls.push(cmd);

    if (cmd[0] === "git" && cmd[1] === "clone") {
      const dest = cmd[3] ?? "";
      clone(dest);
      mkdirSync(join(dest, ".git"), { recursive: true });

      return ok();
    }

    if (cmd[0] === "claude") {
      return existsSync(join(cmd[3] ?? "", "BAD")) ? failed("plugin.json: name is invalid") : ok("valid");
    }

    const fixed = responses.get(cmd.slice(0, 2).join(" "));

    if (fixed) {
      return fixed;
    }

    return failed(`unexpected ${cmd.join(" ")}`);
  };

  return { run, calls, responses };
}

let n = 0;
let deps: ModsDeps & { lines: string[]; calls: string[][]; responses: Map<string, RunResult> };

beforeEach(() => {
  const lines: string[] = [];
  const fake = fakeRunner();
  deps = { dir: join(tmp, `mods-${++n}`), run: fake.run, out: (l) => lines.push(l), lines, calls: fake.calls, responses: fake.responses };
});

const marketplace = (dir: string) => JSON.parse(readFileSync(join(dir, ".claude-plugin", "marketplace.json"), "utf8"));

describe("modsDir", () => {
  test("defaults to mods in Claude's config folder", () => {
    expect(modsDir(undefined)).toBe(join(process.env.CLAUDE_CONFIG_DIR ?? "", "mods"));
  });

  test("expands ~ and ~/, keeps an absolute path, and resolves a relative one from the root", () => {
    expect(modsDir("~", "/home/u")).toBe("/home/u");
    expect(modsDir("rel/mods", "/home/u")).toBe(join(root(), "rel/mods"));
    expect(modsDir("~/m", "/home/u")).toBe("/home/u/m");
    expect(modsDir("/abs/mods", "/home/u")).toBe("/abs/mods");
  });

  test("comes from the root config's mods-dir", () => {
    expect(rootLayersFrom(parseYaml("mods-dir: ~/my-mods\n", "c.yml"), "c.yml").modsDir).toBe("~/my-mods");
    expect(rootLayersFrom(undefined, "c.yml").modsDir).toBeUndefined();
  });
});

describe("source names", () => {
  test("tells a git URL from a path", () => {
    expect(isGitUrl("https://github.com/o/r.git")).toBe(true);
    expect(isGitUrl("git@github.com:o/r.git")).toBe(true);
    expect(isGitUrl("./local/mod")).toBe(false);
    expect(isGitUrl("/abs/mod")).toBe(false);
  });

  test("names a mod for the last segment, without .git", () => {
    expect(defaultModName("https://github.com/o/my-mod.git")).toBe("my-mod");
    expect(defaultModName("git@github.com:o/my-mod.git")).toBe("my-mod");
    expect(defaultModName("/abs/path/file-links/")).toBe("file-links");
  });
});

describe("installMod", () => {
  test("links a local folder, validates it and writes the marketplace", () => {
    const src = makePlugin(join(tmp, `src-${n}`), "links", { version: "0.2.0" });
    const mod = installMod(src, undefined, deps);

    expect(lstatSync(join(deps.dir, `src-${n}`)).isSymbolicLink()).toBe(true);
    expect(mod).toMatchObject({ plugin: "links", version: "0.2.0", source: ModSource.Link });
    expect(deps.calls).toEqual([["claude", "plugin", "validate", mod.dir]]);
    expect(marketplace(deps.dir)).toMatchObject({ name: MODS_MARKETPLACE, plugins: [{ name: "links", source: `./src-${n}` }] });
  });

  test("clones a git URL under --name", () => {
    const mod = installMod("https://example.test/me/cloned.git", "mine", deps);

    expect(deps.calls[0]).toEqual(["git", "clone", "https://example.test/me/cloned.git", join(deps.dir, "mine")]);
    expect(mod).toMatchObject({ folder: "mine", plugin: "cloned", source: ModSource.Git });
  });

  test("removes a mod the validator rejects, and prints why", () => {
    const src = makePlugin(join(tmp, `bad-${n}`), "bad", { bad: true });

    expect(() => installMod(src, "bad", deps)).toThrow("plugin.json: name is invalid");
    expect(existsSync(join(deps.dir, "bad"))).toBe(false);
    expect(existsSync(src)).toBe(true);
    expect(marketplace(deps.dir).plugins).toEqual([]);
  });

  test("refuses a folder with no plugin.json", () => {
    const src = join(tmp, `plain-${n}`);
    mkdirSync(src, { recursive: true });

    expect(() => installMod(src, undefined, deps)).toThrow("is not a Claude Code plugin");
    expect(existsSync(join(deps.dir, `plain-${n}`))).toBe(false);
  });

  test("refuses a name already installed", () => {
    const src = makePlugin(join(tmp, `dup-${n}`), "dup");
    installMod(src, "dup", deps);

    expect(() => installMod(src, "dup", deps)).toThrow("already installed");
  });

  test("refuses a second mod with the same plugin name", () => {
    installMod(makePlugin(join(tmp, `a-${n}`), "same"), "a", deps);

    expect(() => installMod(makePlugin(join(tmp, `b-${n}`), "same"), "b", deps)).toThrow("already has the plugin name 'same'");
    expect(existsSync(join(deps.dir, "b"))).toBe(false);
  });

  test("removes a clone that fails, or that the validator rejects", () => {
    const failing = fakeRunner((dest) => mkdirSync(dest, { recursive: true }));
    const failDeps = { ...deps, run: (cmd: string[]) => (cmd[1] === "clone" ? (failing.run(cmd), failed("fatal: repository not found")) : failing.run(cmd)) };

    expect(() => installMod("https://example.test/x.git", "gone", failDeps)).toThrow("fatal: repository not found");
    expect(existsSync(join(deps.dir, "gone"))).toBe(false);

    const rejecting = fakeRunner((dest) => makePlugin(dest, "rejected", { bad: true }));

    expect(() => installMod("https://example.test/y.git", "rejected", { ...deps, run: rejecting.run })).toThrow("plugin.json: name is invalid");
    expect(existsSync(join(deps.dir, "rejected"))).toBe(false);
    expect(marketplace(deps.dir).plugins).toEqual([]);
  });

  test("refuses an invalid name and a missing path", () => {
    expect(() => installMod("/x", "../up", deps)).toThrow("not a valid mod name");
    expect(() => installMod(join(tmp, "nowhere"), undefined, deps)).toThrow("does not exist");
  });
});

describe("modsMarketplace", () => {
  test("leaves out a mod with no plugin name, and keeps the first folder on a name clash", () => {
    const mod = (folder: string, plugin?: string) => ({ dir: `/m/${folder}`, folder, plugin, source: ModSource.Folder });

    expect(modsMarketplace([mod("a", "x"), mod("b", "x"), mod("c")]).plugins).toEqual([{ name: "x", source: "./a" }]);
  });
});

describe("agentModsRefusal", () => {
  test("refuses an agent and lets the user through", () => {
    expect(agentModsRefusal({ CLAUDECODE: "1" })).toContain("ask them to run it");
    expect(agentModsRefusal({})).toBeUndefined();
  });
});

describe("updateMods", () => {
  test("reports a failed pull, skips a plain folder, and counts only the failure", () => {
    installMod("https://example.test/me/cloned.git", "git-mod", deps);
    makePlugin(join(deps.dir, "plain"), "plain");
    deps.responses.set("git pull", failed("fatal: Not possible to fast-forward"));

    expect(updateMods(undefined, deps)).toBe(1);
    expect(deps.lines.slice(-2)).toEqual(["git-mod: failed (git pull --ff-only failed: fatal: Not possible to fast-forward)", "plain: skipped (not a git checkout)"]);
    expect(marketplace(deps.dir).plugins.map((p: { name: string }) => p.name)).toEqual(["plain"]);
  });

  test("resets a pull that fails validation to the commit before it", () => {
    installMod("https://example.test/me/cloned.git", "git-mod", deps);
    writeFileSync(join(deps.dir, "git-mod", "BAD"), "");
    const heads = ["abc123\n", "def456\n"];
    const runHead = deps.run;
    deps.run = (cmd, opts) => (cmd[1] === "rev-parse" ? ok(heads.shift() ?? "") : runHead(cmd, opts));

    expect(updateMods("git-mod", deps)).toBe(1);
    expect(deps.calls).toContainEqual(["git", "reset", "--keep", "abc123"]);
    expect(deps.lines.at(-1)).toContain("git-mod: kept (pulled, but claude plugin validate rejects it");
    expect(deps.lines.at(-1)).toContain("reset to abc123, the last commit that passed");
    expect(marketplace(deps.dir).plugins).toEqual([{ name: "cloned", source: "./git-mod" }]);
  });

  test("drops a mod that fails its check when the pull did not move it", () => {
    installMod("https://example.test/me/cloned.git", "git-mod", deps);
    writeFileSync(join(deps.dir, "git-mod", "BAD"), "");

    expect(updateMods("git-mod", deps)).toBe(1);
    expect(deps.calls.some((c) => c[1] === "reset")).toBe(false);
    expect(deps.lines.at(-1)).toContain("it no longer loads");
    expect(marketplace(deps.dir).plugins).toEqual([]);
  });

  test("checks a folder added by hand and lists it once it passes", () => {
    makePlugin(join(deps.dir, "by-hand"), "by-hand");
    makePlugin(join(deps.dir, "broken"), "broken", { bad: true });

    expect(updateMods(undefined, deps)).toBe(1);
    expect(marketplace(deps.dir).plugins).toEqual([{ name: "by-hand", source: "./by-hand" }]);
  });

  test("pulls git mods, skips linked ones and reports each", () => {
    installMod("https://example.test/me/cloned.git", "git-mod", deps);
    installMod(makePlugin(join(tmp, `l-${n}`), "linked"), "link-mod", deps);
    deps.calls.length = 0;

    expect(updateMods(undefined, deps)).toBe(0);
    expect(deps.calls).toEqual([
      ["git", "rev-parse", "HEAD"],
      ["git", "pull", "--ff-only"],
      ["claude", "plugin", "validate", join(deps.dir, "git-mod")],
      ["claude", "plugin", "validate", join(deps.dir, "link-mod")],
    ]);
    expect(deps.lines.slice(-2)).toEqual(["git-mod: updated (Already up to date.)", `link-mod: skipped (linked to ${join(tmp, `l-${n}`)}; edit it there)`]);
  });

  test("refuses an unknown name", () => {
    expect(() => updateMods("nope", deps)).toThrow("no mod named 'nope'");
  });
});

describe("listModLines", () => {
  test("shows name, version, source and validity", () => {
    installMod("https://example.test/me/cloned.git", "git-mod", deps);
    const src = makePlugin(join(tmp, `l-${n}`), "linked");
    installMod(src, "link-mod", deps);
    writeFileSync(join(src, "BAD"), "");

    expect(listModLines(deps)).toEqual([
      "git-mod\t1.0.0\tgit https://example.test/me/cloned.git\tvalid",
      `link-mod\t-\tlink ${src}\tinvalid: plugin.json: name is invalid`,
    ]);
  });
});

describe("removeMod", () => {
  test("unlinks a linked mod and keeps its target", () => {
    const src = makePlugin(join(tmp, `keep-${n}`), "keep");
    installMod(src, "keep", deps);
    removeMod("keep", deps);

    expect(existsSync(join(deps.dir, "keep"))).toBe(false);
    expect(existsSync(join(src, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(marketplace(deps.dir).plugins).toEqual([]);
  });

  test("deletes a cloned mod", () => {
    installMod("https://example.test/me/cloned.git", "gone", deps);
    removeMod("gone", deps);

    expect(listMods(deps.dir)).toEqual([]);
  });

  test("refuses an unknown name, and a name that leaves the mods folder", () => {
    installMod(makePlugin(join(tmp, `stay-${n}`), "stay"), "stay", deps);

    expect(() => removeMod("nope", deps)).toThrow("no mod named 'nope'");
    expect(() => removeMod("..", deps)).toThrow("no mod named '..'");
    expect(() => removeMod("../x", deps)).toThrow("no mod named '../x'");
    expect(listMods(deps.dir).map((m) => m.folder)).toEqual(["stay"]);
  });
});

describe("settings", () => {
  test("none without mods", () => {
    expect(modsSettings(join(tmp, "empty"))).toEqual({});
  });

  test("registers the mods folder and enables each mod, beside the overbridge plugins", () => {
    installMod(makePlugin(join(tmp, `s-${n}`), "shiny"), "shiny", deps);
    const mods = modsSettings(deps.dir);

    const base = {
      extraKnownMarketplaces: { overbridge: { source: { source: "directory", path: "/pkg" } } },
      enabledPlugins: { "overbridge@overbridge": true },
    };

    expect(workspacePluginSettings(base, mods)).toEqual({
      extraKnownMarketplaces: {
        overbridge: { source: { source: "directory", path: "/pkg" } },
        [MODS_MARKETPLACE]: { source: { source: "directory", path: deps.dir } },
      },
      enabledPlugins: { "overbridge@overbridge": true, [`shiny@${MODS_MARKETPLACE}`]: true },
    });
    expect(workspacePluginSettings(base, {})).toEqual(base);
  });

  test("warns and loads nothing when marketplace.json can't be read", () => {
    mkdirSync(join(deps.dir, ".claude-plugin", "marketplace.json"), { recursive: true });
    const warnings: string[] = [];

    expect(modsSettings(deps.dir, (m) => warnings.push(m))).toEqual({});
    expect(warnings[0]).toContain("could not load the Claude Code mods");
  });

  test("loads only what marketplace.json lists, not a folder added by hand", () => {
    installMod(makePlugin(join(tmp, `k-${n}`), "kept"), "kept", deps);
    makePlugin(join(deps.dir, "by-hand"), "by-hand");

    expect(Object.keys(modsSettings(deps.dir).enabledPlugins ?? {})).toEqual([`kept@${MODS_MARKETPLACE}`]);
    expect(listModLines(deps)[0]).toContain("valid, not loaded");

    installMod(makePlugin(join(tmp, `o-${n}`), "other"), "other", deps);
    removeMod("kept", deps);

    expect(Object.keys(modsSettings(deps.dir).enabledPlugins ?? {})).toEqual([`other@${MODS_MARKETPLACE}`]);
  });
});
