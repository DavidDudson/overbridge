import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { isJsonObject, isJsonString } from "./json";
import { NAME_RE, root } from "./paths";
import { loadRootLayers } from "./project-config";
import { errorMessage, OverbridgeError, run, type RunResult } from "./util";

/** The marketplace overbridge writes into the mods folder; each mod is enabled as `<name>@${MODS_MARKETPLACE}`. */
export const MODS_MARKETPLACE = "overbridge-mods";
const MANIFEST = join(".claude-plugin", "plugin.json");
const MARKETPLACE_FILE = join(".claude-plugin", "marketplace.json");

/** Runs a command and reports how it went; tests pass a fake so no real git or claude runs. */
export type Runner = (cmd: string[], opts?: { cwd?: string }) => RunResult;

/** How a mod got into the mods folder. */
export const ModSource = { Git: "git", Link: "link", Folder: "folder" } as const;

export type ModSource = (typeof ModSource)[keyof typeof ModSource];

/** One subfolder of the mods folder. `plugin` is the name in its plugin.json, undefined when that is unreadable. */
export interface Mod {
  dir: string;
  folder: string;
  plugin?: string;
  version?: string;
  source: ModSource;
}

/** The mods folder: the root config's `mods-dir` (absolute, `~/` or root-relative), else `mods` in Claude's config folder. */
export function modsDir(configured = loadRootLayers().modsDir, home = homedir()): string {
  if (configured === undefined) {
    return join(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "mods");
  }

  if (configured === "~" || configured.startsWith("~/")) {
    return join(home, configured.slice(1));
  }

  return isAbsolute(configured) ? configured : resolve(root(), configured);
}

/** The fields of a mod's plugin.json that overbridge reads. */
interface Manifest {
  name?: string;
  version?: string;
}

function readManifest(dir: string): Manifest {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));

    if (!isJsonObject(parsed)) {
      return {};
    }

    return { name: isJsonString(parsed.name) ? parsed.name : undefined, version: isJsonString(parsed.version) ? parsed.version : undefined };
  } catch {
    return {};
  }
}

const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

const exists = (p: string) => isLink(p) || existsSync(p);

/** Every mod in `dir`, by folder name. A missing folder holds none; dot folders (`.claude-plugin`) are not mods. */
export function listMods(dir: string): Mod[] {
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink()))
    .map((e) => e.name)
    .toSorted()
    .map((folder) => {
      const path = join(dir, folder);
      const { name, version } = readManifest(path);
      const source = isLink(path) ? ModSource.Link : existsSync(join(path, ".git")) ? ModSource.Git : ModSource.Folder;

      return { dir: path, folder, plugin: name, version, source };
    });
}

/** The marketplace for `mods`: one plugin per mod with a named plugin.json, the first folder winning a name clash. */
export function modsMarketplace(mods: readonly Mod[]) {
  const named = mods.filter((m): m is Mod & { plugin: string } => m.plugin !== undefined);
  const unique = named.filter((m, i) => named.findIndex((o) => o.plugin === m.plugin) === i);

  return {
    name: MODS_MARKETPLACE,
    owner: { name: "overbridge" },
    description: "Claude Code mods installed with overbridge mods",
    plugins: unique.map((m) => ({ name: m.plugin, source: `./${m.folder}` })),
  };
}

/**
 * (Re)write `<dir>/.claude-plugin/marketplace.json` from the mods in `dir`, only when it changed, so launches
 * that run it at once never see a half-written file. Returns the marketplace written.
 */
export function writeModsMarketplace(dir: string) {
  const marketplace = modsMarketplace(listMods(dir));
  const file = join(dir, MARKETPLACE_FILE);
  const text = JSON.stringify(marketplace, null, 2) + "\n";
  const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;

  if (current !== text) {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  }

  return marketplace;
}

/**
 * Claude settings that register the mods folder as a directory marketplace and enable every mod in it, after
 * syncing its marketplace.json. Empty with no mods. A mods folder that can't be read is skipped with a warning
 * from `warn`: the generated files never block a launch.
 */
export function modsSettings(dir = modsDir(), warn: (msg: string) => void = () => {}) {
  try {
    if (!listMods(dir).length) {
      return {};
    }

    const marketplace = writeModsMarketplace(dir);

    return {
      extraKnownMarketplaces: { [MODS_MARKETPLACE]: { source: { source: "directory", path: dir } } },
      enabledPlugins: Object.fromEntries(marketplace.plugins.map((p) => [`${p.name}@${MODS_MARKETPLACE}`, true])),
    };
  } catch (e) {
    warn(`warning: could not load the mods in ${dir}: ${errorMessage(e)}`);

    return {};
  }
}

/** Whether `source` is a git URL rather than a local folder. */
export const isGitUrl = (source: string) => /^(https?|ssh|git|file):\/\//.test(source) || /^[\w.-]+@[\w.-]+:/.test(source);

/** The folder name a source installs to when no `--name` is given: its last path segment, without `.git`. */
export function defaultModName(source: string): string {
  return basename(source.replace(/\/+$/, "").replace(/^.*:/, "")).replace(/\.git$/, "");
}

export interface ModsDeps {
  dir: string;
  run: Runner;
  out: (line: string) => void;
}

const defaultDeps = (): ModsDeps => ({ dir: modsDir(), run, out: (line) => console.log(line) });

function validate(deps: ModsDeps, dir: string): RunResult {
  return deps.run(["claude", "plugin", "validate", dir]);
}

const output = (r: RunResult) => [r.stdout, r.stderr].flatMap((s) => (s.trim() ? [s.trim()] : [])).join("\n");

function removeMod(path: string) {
  if (isLink(path)) {
    unlinkSync(path);
  } else {
    rmSync(path, { recursive: true, force: true });
  }
}

/** `overbridge mods install <git-url|path> [--name x]`: clone or link a mod, validate it, and add it to the marketplace. */
export function installMod(source: string, name: string | undefined, deps: ModsDeps = defaultDeps()): Mod {
  const folder = name ?? defaultModName(source);

  if (!NAME_RE.test(folder)) {
    throw new OverbridgeError(`'${folder}' is not a valid mod name: use letters, digits, '.', '_' and '-', starting with a letter or digit. Pass one with --name.`);
  }

  const dest = join(deps.dir, folder);

  if (exists(dest)) {
    throw new OverbridgeError(`a mod named '${folder}' is already installed at ${dest}. Remove it with 'overbridge mods rm ${folder}' or pick another --name.`);
  }

  const git = isGitUrl(source);
  const target = git ? source : resolve(source);

  if (!git && !existsSync(target)) {
    throw new OverbridgeError(`${target} does not exist: pass a git URL or a folder holding ${MANIFEST}`);
  }

  mkdirSync(deps.dir, { recursive: true });

  if (git) {
    const r = deps.run(["git", "clone", source, dest]);

    if (!r.ok) {
      removeMod(dest);
      throw new OverbridgeError(`git clone ${source} failed:\n${output(r)}`);
    }
  } else {
    symlinkSync(target, dest);
  }

  const refuse = (msg: string): never => {
    removeMod(dest);
    writeModsMarketplace(deps.dir);
    throw new OverbridgeError(msg);
  };

  const { name: plugin } = readManifest(dest);

  if (plugin === undefined) {
    refuse(`${source} has no ${MANIFEST} with a name, so it is not a Claude Code plugin. Nothing was installed.`);
  }

  const v = validate(deps, dest);

  if (!v.ok) {
    refuse(`claude plugin validate rejected ${source}, so nothing was installed:\n${output(v)}`);
  }

  const clash = listMods(deps.dir).find((m) => m.folder !== folder && m.plugin === plugin);

  if (clash) {
    refuse(`the mod in ${clash.dir} already has the plugin name '${plugin}'. Remove one with 'overbridge mods rm ${clash.folder}'.`);
  }

  writeModsMarketplace(deps.dir);
  const mod = listMods(deps.dir).find((m) => m.folder === folder);

  if (!mod) {
    throw new OverbridgeError(`${dest} vanished while it was being installed`);
  }

  deps.out(`installed ${folder} (${plugin}@${MODS_MARKETPLACE}) from ${source}; start a workspace Claude, or run /reload-plugins in one, to load it`);

  return mod;
}

/** The outcome of updating one mod. */
export const UpdateOutcome = { Updated: "updated", Skipped: "skipped", Failed: "failed" } as const;

export type UpdateOutcome = (typeof UpdateOutcome)[keyof typeof UpdateOutcome];

/** What updating one mod did, and the line that explains it. */
interface UpdateResult {
  outcome: UpdateOutcome;
  detail: string;
}

function updateOne(mod: Mod, deps: ModsDeps): UpdateResult {
  if (mod.source === ModSource.Link) {
    return { outcome: UpdateOutcome.Skipped, detail: `linked to ${readlinkSync(mod.dir)}; edit it there` };
  }

  if (mod.source === ModSource.Folder) {
    return { outcome: UpdateOutcome.Skipped, detail: "not a git checkout" };
  }

  const pull = deps.run(["git", "pull", "--ff-only"], { cwd: mod.dir });

  if (!pull.ok) {
    return { outcome: UpdateOutcome.Failed, detail: `git pull --ff-only failed: ${output(pull)}` };
  }

  const v = validate(deps, mod.dir);

  if (!v.ok) {
    return { outcome: UpdateOutcome.Failed, detail: `pulled, but claude plugin validate rejects it:\n${output(v)}` };
  }

  return { outcome: UpdateOutcome.Updated, detail: pull.stdout.trim().split("\n").at(-1) ?? "" };
}

/** `overbridge mods update [name]`: fast-forward each git mod (or only `name`) and validate it again. Returns the failures. */
export function updateMods(name: string | undefined, deps: ModsDeps = defaultDeps()): number {
  const mods = listMods(deps.dir).filter((m) => name === undefined || m.folder === name);

  if (name !== undefined && !mods.length) {
    throw new OverbridgeError(`no mod named '${name}' in ${deps.dir}; 'overbridge mods ls' lists them`);
  }

  const results = mods.map((m) => ({ mod: m, ...updateOne(m, deps) }));
  results.forEach((r) => deps.out(`${r.mod.folder}: ${r.outcome}${r.detail ? ` (${r.detail})` : ""}`));
  writeModsMarketplace(deps.dir);

  if (!mods.length) {
    deps.out(`no mods installed in ${deps.dir}`);
  }

  return results.filter((r) => r.outcome === UpdateOutcome.Failed).length;
}

function sourceOf(mod: Mod, deps: ModsDeps): string {
  if (mod.source === ModSource.Link) {
    return `link ${readlinkSync(mod.dir)}`;
  }

  if (mod.source === ModSource.Git) {
    const r = deps.run(["git", "remote", "get-url", "origin"], { cwd: mod.dir });

    return r.ok ? `git ${r.stdout.trim()}` : "git (no origin)";
  }

  return "folder";
}

/** `overbridge mods ls`: one tab-separated line per mod: folder, version, source, valid or the reason it is not. */
export function listModLines(deps: ModsDeps = defaultDeps()): string[] {
  return listMods(deps.dir).map((m) => {
    const v = validate(deps, m.dir);
    const valid = v.ok ? "valid" : `invalid: ${output(v).split("\n")[0] ?? ""}`;

    return [m.folder, m.version ?? "-", sourceOf(m, deps), valid].join("\t");
  });
}

/** `overbridge mods rm <name>`: remove a mod's folder, or only the link to a linked one, and drop it from the marketplace. */
export function removeModNamed(name: string, deps: ModsDeps = defaultDeps()) {
  const path = join(deps.dir, name);

  if (!NAME_RE.test(name) || !exists(path)) {
    throw new OverbridgeError(`no mod named '${name}' in ${deps.dir}; 'overbridge mods ls' lists them`);
  }

  const linked = isLink(path);
  removeMod(path);
  writeModsMarketplace(deps.dir);
  deps.out(linked ? `removed the link ${path} (its target is untouched)` : `removed ${path}`);
}
