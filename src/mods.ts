import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { isJsonObject, isJsonString } from "./json";
import { NAME_RE, root } from "./paths";
import type { PluginSettings } from "./plugins";
import { listProcs } from "./proc";
import { ancestry } from "./agent-supervisor";
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

/**
 * Why a mods command that changes what loads may not run here, or undefined when it may. `ancestors` are the
 * executable names above this process: an agent can clear `CLAUDECODE` in its own command, but not the `claude`
 * process it runs under. A `!` command in Claude runs under it too, so the user runs these from a terminal.
 */
export function agentModsRefusal(env: Record<string, string | undefined>, ancestors: readonly string[]): string | undefined {
  return env.CLAUDECODE || ancestors.includes("claude")
    ? "mods change what every workspace Claude loads, so only the user may change them: ask them to run this in a terminal outside Claude"
    : undefined;
}

/** The executable names of this process's ancestors. */
export function ancestorNames(): string[] {
  const procs = new Map(listProcs().map((p) => [p.pid, p]));

  return ancestry(process.pid, (pid) => procs.get(pid)?.ppid).flatMap((pid) => procs.get(pid)?.comm ?? []);
}

/** The mods folder: the root config's `mods-dir` (absolute, `~/` or root-relative), else `mods` in Claude's config folder. */
export function modsDir(configured: string | undefined, home = homedir()): string {
  if (configured === undefined) {
    return join(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "mods");
  }

  if (configured === "~" || configured.startsWith("~/")) {
    return join(home, configured.slice(1));
  }

  return isAbsolute(configured) ? configured : resolve(root(), configured);
}

/** The mods folder the root config names. */
export const configuredModsDir = () => modsDir(loadRootLayers().modsDir);

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

/** True for a dangling symlink too, which `existsSync` reports as missing. */
const existsOrIsLink = (p: string) => isLink(p) || existsSync(p);

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

/** The folders marketplace.json in `dir` lists now, which are the mods that passed `checkMod`. */
const listedFolders = (dir: string) => marketplaceEntries(dir).map((p) => p.source.replace(/^\.\//, ""));

/**
 * Rewrite marketplace.json to the folders it lists, plus `add` and minus `drop`, so it only ever holds mods that
 * passed `checkMod`. An atomic rename keeps tabs launching at once from reading a half-written file.
 */
export function writeModsMarketplace(dir: string, change: { add?: readonly string[]; drop?: readonly string[] } = {}) {
  const keep = new Set([...listedFolders(dir), ...(change.add ?? [])].filter((f) => !(change.drop ?? []).includes(f)));
  const file = join(dir, MARKETPLACE_FILE);
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(modsMarketplace(listMods(dir).filter((mod) => keep.has(mod.folder))), null, 2) + "\n");
  renameSync(tmp, file);
}

/** The plugins marketplace.json in `dir` lists; only the mods commands write it, so a launch loads only checked mods. */
function marketplaceEntries(dir: string): { name: string; source: string }[] {
  const file = join(dir, MARKETPLACE_FILE);

  if (!existsSync(file)) {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new OverbridgeError(`${file} is not valid JSON (${errorMessage(e)}); delete it and run 'overbridge mods update' to rebuild it`);
  }

  const plugins = isJsonObject(parsed) && Array.isArray(parsed.plugins) ? parsed.plugins : [];

  return plugins.flatMap((p) => (isJsonObject(p) && isJsonString(p.name) && isJsonString(p.source) ? [{ name: p.name, source: p.source }] : []));
}

/** Claude settings that register the mods folder as a directory marketplace and enable each mod; a failure warns and loads none. */
export function modsSettings(dir?: string, warn: (msg: string) => void = () => {}): PluginSettings {
  try {
    const at = dir ?? configuredModsDir();
    const plugins = marketplaceEntries(at).map((p) => p.name);

    if (!plugins.length) {
      return {};
    }

    return {
      extraKnownMarketplaces: { [MODS_MARKETPLACE]: { source: { source: "directory", path: at } } },
      enabledPlugins: Object.fromEntries(plugins.map((p) => [`${p}@${MODS_MARKETPLACE}`, true])),
    };
  } catch (e) {
    warn(`warning: could not load the Claude Code mods: ${errorMessage(e)}`);

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

/** `run`, with a program that cannot start (not on PATH) reported as a failed run instead of a throw. */
const safeRun: Runner = (cmd, opts) => {
  try {
    return run(cmd, opts);
  } catch (e) {
    return { ok: false, code: 127, stdout: "", stderr: `${cmd[0]} could not be started: ${errorMessage(e)}` };
  }
};

const defaultDeps = (): ModsDeps => ({ dir: configuredModsDir(), run: safeRun, out: (line) => console.log(line) });

function validate(deps: ModsDeps, dir: string): RunResult {
  return deps.run(["claude", "plugin", "validate", dir]);
}

const combinedOutput = (r: RunResult) => [r.stdout, r.stderr].flatMap((s) => (s.trim() ? [s.trim()] : [])).join("\n");

function removeModFolder(path: string) {
  if (isLink(path)) {
    unlinkSync(path);
  } else {
    rmSync(path, { recursive: true, force: true });
  }
}

/** Why the mod in `dir` may not load (no plugin name, a rejected validation, a plugin name another mod has), or undefined. */
function checkMod(deps: ModsDeps, dir: string, folder: string): string | undefined {
  const { name: plugin } = readManifest(dir);

  if (plugin === undefined) {
    return `it has no ${MANIFEST} with a name, so it is not a Claude Code plugin`;
  }

  const validation = validate(deps, dir);

  if (!validation.ok) {
    return `claude plugin validate rejects it:\n${combinedOutput(validation)}`;
  }

  const clash = listMods(deps.dir).find((m) => m.folder !== folder && m.plugin === plugin);

  return clash ? `the mod in ${clash.dir} already has the plugin name '${plugin}'; remove one with 'overbridge mods rm ${clash.folder}'` : undefined;
}

/** Clone or link `source` to `dest`, or say why it could not. */
function fetchMod(source: string, dest: string, deps: ModsDeps): string | undefined {
  if (!isGitUrl(source)) {
    symlinkSync(resolve(source), dest);

    return undefined;
  }

  const clone = deps.run(["git", "clone", source, dest]);

  return clone.ok ? undefined : `git clone ${source} failed:\n${combinedOutput(clone)}`;
}

/** `overbridge mods install <git-url|path> [--name x]`: clone or link a mod, check it, and add it to the marketplace. */
export function installMod(source: string, name: string | undefined, deps: ModsDeps = defaultDeps()): Mod {
  const folder = name ?? defaultModName(source);

  if (!NAME_RE.test(folder)) {
    throw new OverbridgeError(`'${folder}' is not a valid mod name: use letters, digits, '.', '_' and '-', starting with a letter or digit. Pass one with --name.`);
  }

  const dest = join(deps.dir, folder);

  if (existsOrIsLink(dest)) {
    throw new OverbridgeError(`a mod named '${folder}' is already installed at ${dest}. Remove it with 'overbridge mods rm ${folder}' or pick another --name.`);
  }

  if (!isGitUrl(source) && !existsSync(resolve(source))) {
    throw new OverbridgeError(`${resolve(source)} does not exist: pass a git URL or a folder holding ${MANIFEST}`);
  }

  mkdirSync(deps.dir, { recursive: true });

  try {
    const problem = fetchMod(source, dest, deps) ?? checkMod(deps, dest, folder);

    if (problem) {
      throw new OverbridgeError(`${source} was not installed: ${problem}`);
    }
  } catch (e) {
    removeModFolder(dest);

    try {
      writeModsMarketplace(deps.dir, { drop: [folder] });
    } catch (cleanup) {
      deps.out(`warning: could not update the marketplace after removing ${dest}: ${errorMessage(cleanup)}`);
    }

    throw e;
  }

  writeModsMarketplace(deps.dir, { add: [folder] });
  const mod = listMods(deps.dir).find((m) => m.folder === folder);

  if (!mod) {
    throw new OverbridgeError(`${dest} vanished while it was being installed`);
  }

  deps.out(`installed ${folder} (${mod.plugin}@${MODS_MARKETPLACE}) from ${source}; each workspace Claude started from now on loads it`);

  return mod;
}

/** The outcome of updating one mod. `Kept` failed but stays on the version that passed (a failed pull, or a reset); `Failed` no longer loads. */
export const UpdateOutcome = { Updated: "updated", Skipped: "skipped", Kept: "kept", Failed: "failed" } as const;

export type UpdateOutcome = (typeof UpdateOutcome)[keyof typeof UpdateOutcome];

/** What updating one mod did, and the line that explains it. */
interface UpdateResult {
  outcome: UpdateOutcome;
  detail: string;
}

/** Check a mod that has no git history to pull (a link or a plain folder), so the marketplace can list it. */
function recheck(mod: Mod, deps: ModsDeps): UpdateResult {
  const why = mod.source === ModSource.Link ? `linked to ${readlinkSync(mod.dir)}; edit it there` : "not a git checkout";
  const problem = checkMod(deps, mod.dir, mod.folder);

  return problem === undefined ? { outcome: UpdateOutcome.Skipped, detail: why } : { outcome: UpdateOutcome.Failed, detail: `${why}, and ${problem}` };
}

/** Pull a git mod and check it again; a pull that fails the checks is reset to the commit that passed. */
function updateOne(mod: Mod, deps: ModsDeps): UpdateResult {
  if (mod.source !== ModSource.Git) {
    return recheck(mod, deps);
  }

  const before = deps.run(["git", "rev-parse", "HEAD"], { cwd: mod.dir });
  const pull = deps.run(["git", "pull", "--ff-only"], { cwd: mod.dir });

  if (!pull.ok) {
    return { outcome: UpdateOutcome.Kept, detail: `git pull --ff-only failed, so it stays on the commit that passed: ${combinedOutput(pull)}` };
  }

  const problem = checkMod(deps, mod.dir, mod.folder);

  if (problem === undefined) {
    return { outcome: UpdateOutcome.Updated, detail: pull.stdout.trim().split("\n").at(-1) ?? "" };
  }

  const head = before.stdout.trim();
  const after = deps.run(["git", "rev-parse", "HEAD"], { cwd: mod.dir }).stdout.trim();
  const moved = before.ok && head !== "" && head !== after;

  if (!moved) {
    return { outcome: UpdateOutcome.Failed, detail: `${problem}; it no longer loads` };
  }

  // --keep moves HEAD back but keeps local edits to the clone, and refuses when they would conflict
  const reset = deps.run(["git", "reset", "--keep", head], { cwd: mod.dir });

  if (reset.ok) {
    return { outcome: UpdateOutcome.Kept, detail: `pulled, but ${problem}; reset to ${head}, the last commit that passed` };
  }

  return { outcome: UpdateOutcome.Failed, detail: `pulled, but ${problem}; could not reset it, so it no longer loads` };
}

/** `overbridge mods update [name]`: fast-forward each git mod (or only `name`) and check it again. Returns the failures. */
export function updateMods(name: string | undefined, deps: ModsDeps = defaultDeps()): number {
  const mods = listMods(deps.dir).filter((m) => name === undefined || m.folder === name);

  if (name !== undefined && !mods.length) {
    throw new OverbridgeError(`no mod named '${name}' in ${deps.dir}; 'overbridge mods ls' lists them`);
  }

  const results = mods.map((m) => ({ mod: m, ...updateOne(m, deps) }));
  results.forEach((r) => deps.out(`${r.mod.folder}: ${r.outcome}${r.detail ? ` (${r.detail})` : ""}`));

  const passed = results.filter((r) => r.outcome === UpdateOutcome.Updated || r.outcome === UpdateOutcome.Skipped).map((r) => r.mod.folder);
  const failed = results.filter((r) => r.outcome === UpdateOutcome.Failed).map((r) => r.mod.folder);

  if (mods.length) {
    writeModsMarketplace(deps.dir, { add: passed, drop: failed });
  } else {
    deps.out(`no mods installed in ${deps.dir}`);
  }

  return results.filter((r) => r.outcome === UpdateOutcome.Failed || r.outcome === UpdateOutcome.Kept).length;
}

function sourceOf(mod: Mod, deps: ModsDeps): string {
  if (mod.source === ModSource.Link) {
    return `link ${readlinkSync(mod.dir)}`;
  }

  if (mod.source === ModSource.Git) {
    const remote = deps.run(["git", "remote", "get-url", "origin"], { cwd: mod.dir });

    return remote.ok ? `git ${remote.stdout.trim()}` : "git (no origin)";
  }

  return "folder";
}

/** `overbridge mods ls`: one tab-separated line per mod: folder, version, source, and valid, invalid or not loaded. */
export function listModLines(deps: ModsDeps = defaultDeps()): string[] {
  const loaded = new Set(marketplaceEntries(deps.dir).map((p) => p.source));

  return listMods(deps.dir).map((m) => {
    const validation = validate(deps, m.dir);
    const loadState = loaded.has(`./${m.folder}`) ? "valid" : "valid, not loaded: 'overbridge mods update' adds it unless another mod has its plugin name";
    const state = validation.ok ? loadState : `invalid: ${combinedOutput(validation).split("\n")[0] ?? ""}`;

    return [m.folder, m.version ?? "-", sourceOf(m, deps), state].join("\t");
  });
}

/** `overbridge mods rm <name>`: remove a mod's folder, or only the link to a linked one, and drop it from the marketplace. */
export function removeMod(name: string, deps: ModsDeps = defaultDeps()) {
  const path = join(deps.dir, name);

  if (!NAME_RE.test(name) || !existsOrIsLink(path)) {
    throw new OverbridgeError(`no mod named '${name}' in ${deps.dir}; 'overbridge mods ls' lists them`);
  }

  const linked = isLink(path);
  removeModFolder(path);
  writeModsMarketplace(deps.dir, { drop: [name] });
  deps.out(linked ? `removed the link ${path} (its target is untouched)` : `removed ${path}`);
}
