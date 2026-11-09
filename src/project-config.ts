import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoOf, root, worktreePath } from "./paths";
import { fail } from "./util";

/** Per-repo rules live in `overbridge.yml` at the repo (worktree) root. */
export const CONFIG_FILE = "overbridge.yml";
export const CONFIG_VERSION = 1;

export const PM_NAMES = ["github", "jira"] as const;
export type PmName = (typeof PM_NAMES)[number];

export const IDES = ["vscode", "zed", "webstorm"] as const;
export type Ide = (typeof IDES)[number];

export interface ProjectManagement {
  name: PmName;
  project: string;
  /** Provider base URL, e.g. a Jira site. */
  url?: string;
  /**
   * Where tech-debt items go: the id of a parent item (an epic), or `label:<name>` to tag them instead.
   * Unset means tech-debt items are filed with no parent.
   */
  techDebt?: string;
}

export const APP_WHEN = ["always", "feature-branch"] as const;
export type AppWhen = (typeof APP_WHEN)[number];

/** How to tell an app is up. A tcp `port` of undefined means the port allocated at start. */
export type Ready = { kind: "http"; url: string } | { kind: "tcp"; port?: number };

/** One launchable app. `{port}` in `start`, `stop`, `prepare` and the ready url is the allocated port. */
export interface AppSpec {
  id: string;
  label: string;
  /** Working directory, relative to the repo root. */
  dir: string;
  start: string;
  /** Teardown command; absent means signal the whole process group. */
  stop?: string;
  /** Runs to completion before `start`. */
  prepare?: string;
  /** Pool of ports; at most this many workspaces can run the app at once. Empty when it needs none. */
  ports: number[];
  ready?: Ready;
  /** Open the browser once ready. */
  open: boolean;
  when: AppWhen;
}

/** Shell commands skills run to check a change. Each is optional; a missing one means the repo has none. */
export const COMMAND_NAMES = ["lint", "typecheck", "test", "build", "format"] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];
export type Commands = Partial<Record<CommandName, string>>;

/**
 * Shell commands overbridge runs at points in a worktree's life. Read only from the root `config.yml`: a hook
 * in a repo's own file would run whatever a checked-out branch says.
 */
export const HOOK_NAMES = ["post-add", "post-checkout", "post-pr", "pre-remove"] as const;
export type HookName = (typeof HOOK_NAMES)[number];
export type Hooks = Partial<Record<HookName, string[]>>;

export const DEFAULT_PERSONA_DIR = ".overbridge/personas";

export interface ReviewConfig {
  /** Reviewer personas to run; unset means auto-select by diff signals. */
  personas?: string[];
  /** Personas to skip, applied after `personas` or auto-selection. */
  exclude: string[];
  /** Repo-relative directory of repo-local personas. */
  localDir: string;
}

export interface ProjectConfig {
  version: typeof CONFIG_VERSION;
  projectManagement?: ProjectManagement;
  apps: AppSpec[];
  commands: Commands;
  review: ReviewConfig;
  ide?: Ide;
  /** Lifecycle hooks, from the root `config.yml` only. Present only when there are any. */
  hooks?: Hooks;
  /** Top panel buttons, from the root `config.yml` only. */
  buttons: ButtonSpec[];
  /** Top-level `x-<name>` keys, as written. Present only when there are any. */
  extensions?: Record<string, unknown>;
}

export const defaultConfig = (): ProjectConfig => ({
  version: CONFIG_VERSION,
  apps: [],
  commands: {},
  review: { exclude: [], localDir: DEFAULT_PERSONA_DIR },
  buttons: [],
});

const TOP_KEYS = ["version", "project-management", "apps", "commands", "review", "ide", "hooks", "buttons"];
const REVIEW_KEYS = ["personas", "exclude", "local-dir"];
const PM_KEYS = ["name", "project", "url", "tech-debt"];
const APP_KEYS = ["id", "label", "dir", "start", "stop", "prepare", "ports", "ready", "open", "when"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

/** The allowed key closest to `key`, if it is plausibly a typo of it. */
export function suggest(key: string, allowed: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of allowed) {
    const d = distance(key.toLowerCase(), candidate);
    if (d < bestDistance) [best, bestDistance] = [candidate, d];
  }
  return bestDistance <= Math.max(2, Math.floor(key.length / 3)) ? best : undefined;
}

/** `x-<name>` keys are left for extensions: overbridge keeps them as written and never reads them. */
export const isExtensionKey = (key: string) => /^x-[A-Za-z0-9]/.test(key);

class Problems {
  readonly list: string[] = [];
  /** A partial layer of a merged config: required keys may come from another layer. */
  constructor(readonly partial = false) {}
  add(path: string, message: string) {
    this.list.push(path ? `${path}: ${message}` : message);
  }
  /** Report every key of `obj` not in `allowed`, suggesting the nearest valid key. */
  unknownKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string, extensions = false) {
    for (const key of Object.keys(obj)) {
      if (allowed.includes(key) || (extensions && isExtensionKey(key))) continue;
      const hint = suggest(key, allowed);
      this.add(path ? `${path}.${key}` : key, `unknown key${hint ? `, did you mean '${hint}'?` : ` (allowed: ${allowed.join(", ")})`}`);
    }
  }
  string(obj: Record<string, unknown>, key: string, path: string, required: boolean): string | undefined {
    const at = path ? `${path}.${key}` : key;
    const v = obj[key];
    if (v === undefined || v === null) {
      if (required && !this.partial) this.add(at, "required");
      return;
    }
    // YAML parses `project: 123` as a number; accept it for ids and project numbers.
    if (typeof v === "number") return String(v);
    if (typeof v !== "string" || v === "") {
      this.add(at, "expected a non-empty string");
      return;
    }
    return v;
  }
  /** A list of non-empty strings, or undefined when the key is absent. */
  stringList(obj: Record<string, unknown>, key: string, path: string): string[] | undefined {
    const at = `${path}.${key}`;
    const v = obj[key];
    if (v === undefined || v === null) return;
    if (!Array.isArray(v)) {
      this.add(at, "expected a list of strings");
      return;
    }
    const out: string[] = [];
    v.forEach((item, i) => {
      if (typeof item !== "string" || item === "") this.add(`${at}[${i}]`, "expected a non-empty string");
      else out.push(item);
    });
    return out;
  }
  oneOf<T extends string>(value: string | undefined, choices: readonly T[], path: string): T | undefined {
    if (value === undefined) return;
    if ((choices as readonly string[]).includes(value)) return value as T;
    this.add(path, `expected one of ${choices.join(", ")} (got "${value}")`);
  }
}

const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const portOk =(n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 65535;

function validateApp(entry: Record<string, unknown>, path: string, p: Problems): AppSpec | undefined {
  p.unknownKeys(entry, APP_KEYS, path);
  const id = p.string(entry, "id", path, true);
  // the id names the app's record and log files, so it must not be able to leave their directory
  if (id !== undefined && !APP_ID_RE.test(id)) p.add(`${path}.id`, `'${id}' must start with a letter or digit and use only letters, digits, '.', '_' and '-'`);
  const start = p.string(entry, "start", path, true);
  const label = p.string(entry, "label", path, false);
  const dir = p.string(entry, "dir", path, false);
  const prepare = p.string(entry, "prepare", path, false);

  // `stop: ~` (or absent) means kill the process group
  let stop: string | undefined;
  if (entry.stop !== undefined && entry.stop !== null) stop = p.string(entry, "stop", path, false);

  let ports: number[] = [];
  if (entry.ports !== undefined) {
    if (!Array.isArray(entry.ports) || !entry.ports.every(portOk)) p.add(`${path}.ports`, "expected a list of ports (1-65535)");
    else if (new Set(entry.ports).size !== entry.ports.length) p.add(`${path}.ports`, "duplicate port");
    else ports = entry.ports;
  }

  let ready: Ready | undefined;
  if (entry.ready !== undefined && entry.ready !== null) {
    const r = entry.ready;
    if (!isObject(r)) p.add(`${path}.ready`, "expected a mapping with http or tcp");
    else {
      p.unknownKeys(r, ["http", "tcp"], `${path}.ready`);
      if ((r.http === undefined) === (r.tcp === undefined)) p.add(`${path}.ready`, "set exactly one of http or tcp");
      else if (r.http !== undefined) {
        const url = p.string(r, "http", `${path}.ready`, true);
        if (url) ready = { kind: "http", url };
      } else if (r.tcp === "{port}" || r.tcp === true) ready = { kind: "tcp" };
      else if (portOk(r.tcp)) ready = { kind: "tcp", port: r.tcp };
      else p.add(`${path}.ready.tcp`, 'expected a port number or "{port}"');
    }
  }

  let open = false;
  if (entry.open !== undefined) {
    if (typeof entry.open !== "boolean") p.add(`${path}.open`, "expected true or false");
    else open = entry.open;
  }

  const when = p.oneOf(p.string(entry, "when", path, false), APP_WHEN, `${path}.when`) ?? "always";

  const usesPort = [start, stop, prepare, ready?.kind === "http" ? ready.url : undefined].some((s) => s?.includes("{port}"));
  if (usesPort && ports.length === 0) p.add(`${path}.ports`, "required when a command or ready url uses {port}");
  if (ready?.kind === "tcp" && ready.port === undefined && ports.length === 0) p.add(`${path}.ready.tcp`, "{port} needs ports");

  if (!id || !start) return;
  return {
    id,
    label: label ?? id,
    dir: dir ?? ".",
    start,
    ...(stop ? { stop } : {}),
    ...(prepare ? { prepare } : {}),
    ports,
    ...(ready ? { ready } : {}),
    open,
    when,
  };
}

const ROOT_ONLY = "only allowed in the root config.yml, so a checked-out branch can't run commands";

/** A button the top panel shows, from the root `config.yml` only (its `status` runs on every refresh). */
export interface ButtonSpec {
  id: string;
  label: string;
  /** Shell command run in the worktree on each refresh: its output is the button's text, no output hides it. */
  status?: string;
  /** Shell command run in the worktree, detached, when the button is pressed. */
  run?: string;
  /** URL opened when the button is pressed: `{ws}`, `{repo}`, `{branch}` and `{pr}` are filled in. */
  url?: string;
  side: "left" | "right";
}
const BUTTON_KEYS = ["id", "label", "status", "run", "url", "side"];

/**
 * Validate parsed YAML. Throws one error naming `file` and every offending key. With `partial`, `raw` is
 * one layer of a merged config, so a missing required key is not an error. With `root`, the root-only keys
 * (`hooks`, `buttons`) are allowed.
 */
export function validateConfig(raw: unknown, file = CONFIG_FILE, { partial = false, root = false } = {}): ProjectConfig {
  if (raw === null || raw === undefined) return defaultConfig();
  const p = new Problems(partial);
  const config = defaultConfig();
  if (!isObject(raw)) fail(`${file}: expected a mapping at the top level`);

  p.unknownKeys(raw, TOP_KEYS, "", true);
  const extensions = Object.entries(raw).filter(([key]) => isExtensionKey(key));
  if (extensions.length) config.extensions = Object.fromEntries(extensions);

  if (raw.version !== undefined && raw.version !== CONFIG_VERSION) {
    p.add("version", `unsupported version ${JSON.stringify(raw.version)} (this overbridge reads version ${CONFIG_VERSION})`);
  }

  const pm = raw["project-management"];
  if (pm !== undefined && pm !== null) {
    if (!isObject(pm)) p.add("project-management", "expected a mapping with name and project");
    else {
      p.unknownKeys(pm, PM_KEYS, "project-management");
      const name = p.oneOf(p.string(pm, "name", "project-management", true), PM_NAMES, "project-management.name");
      const project = p.string(pm, "project", "project-management", true);
      const url = p.string(pm, "url", "project-management", false);
      const techDebt = p.string(pm, "tech-debt", "project-management", false);
      if (name && project) {
        config.projectManagement = { name, project, ...(url ? { url } : {}), ...(techDebt ? { techDebt } : {}) };
      }
    }
  }

  const apps = raw.apps;
  if (apps !== undefined && apps !== null) {
    if (!Array.isArray(apps)) p.add("apps", "expected a list");
    else {
      const seen = new Set<string>();
      apps.forEach((entry, i) => {
        const path = `apps[${i}]`;
        if (!isObject(entry)) return p.add(path, "expected a mapping");
        const before = p.list.length;
        const app = validateApp(entry, path, p);
        if (app && seen.has(app.id)) p.add(`${path}.id`, `duplicate app id '${app.id}'`);
        if (app) seen.add(app.id);
        if (app && p.list.length === before) config.apps.push(app);
      });
    }
  }

  const hooks = raw.hooks;
  if (hooks !== undefined && hooks !== null) {
    if (!root) p.add("hooks", ROOT_ONLY);
    else if (!isObject(hooks)) p.add("hooks", "expected a mapping of hook name to a command or a list of commands");
    else {
      p.unknownKeys(hooks, HOOK_NAMES, "hooks");
      const out: Hooks = {};
      for (const name of HOOK_NAMES) {
        const value = hooks[name];
        if (value === undefined || value === null) continue;
        const list = typeof value === "string" ? (value ? [value] : undefined) : p.stringList(hooks, name, "hooks");
        if (list === undefined && typeof value === "string") p.add(`hooks.${name}`, "expected a non-empty string");
        if (list?.length) out[name] = list;
      }
      if (Object.keys(out).length) config.hooks = out;
    }
  }

  const buttons = raw.buttons;
  if (buttons !== undefined && buttons !== null) {
    if (!root) p.add("buttons", ROOT_ONLY);
    else if (!Array.isArray(buttons)) p.add("buttons", "expected a list");
    else {
      const seen = new Set<string>();
      buttons.forEach((entry, i) => {
        const at = `buttons[${i}]`;
        if (!isObject(entry)) return p.add(at, "expected a mapping");
        p.unknownKeys(entry, BUTTON_KEYS, at);
        const id = p.string(entry, "id", at, true);
        if (id !== undefined && !APP_ID_RE.test(id)) p.add(`${at}.id`, `'${id}' must start with a letter or digit and use only letters, digits, '.', '_' and '-'`);
        if (id && seen.has(id)) p.add(`${at}.id`, `duplicate button id '${id}'`);
        if (id) seen.add(id);
        const label = p.string(entry, "label", at, true);
        const status = p.string(entry, "status", at, false);
        const runCmd = p.string(entry, "run", at, false);
        const url = p.string(entry, "url", at, false);
        if (runCmd && url) p.add(at, "set run or url, not both");
        if (!runCmd && !url && !status && !partial) p.add(at, "set run, url or status");
        const side = p.oneOf(p.string(entry, "side", at, false), ["left", "right"] as const, `${at}.side`) ?? "right";
        if (id && label)
          config.buttons.push({ id, label, side, ...(status ? { status } : {}), ...(runCmd ? { run: runCmd } : {}), ...(url ? { url } : {}) });
      });
    }
  }

  const commands = raw.commands;
  if (commands !== undefined && commands !== null) {
    if (!isObject(commands)) p.add("commands", "expected a mapping of command name to shell command");
    else {
      p.unknownKeys(commands, COMMAND_NAMES, "commands");
      for (const name of COMMAND_NAMES) {
        const command = p.string(commands, name, "commands", false);
        if (command) config.commands[name] = command;
      }
    }
  }

  const review = raw.review;
  if (review !== undefined && review !== null) {
    if (!isObject(review)) p.add("review", "expected a mapping");
    else {
      p.unknownKeys(review, REVIEW_KEYS, "review");
      const personas = p.stringList(review, "personas", "review");
      if (personas) config.review.personas = personas;
      config.review.exclude = p.stringList(review, "exclude", "review") ?? [];
      config.review.localDir = p.string(review, "local-dir", "review", false) ?? DEFAULT_PERSONA_DIR;
    }
  }

  const ide = p.oneOf(p.string(raw, "ide", "", false), IDES, "ide");
  if (ide) config.ide = ide;

  if (p.list.length) fail(`${file}:\n${p.list.map((line) => `  ${line}`).join("\n")}`);
  return config;
}

/** Parse YAML text, naming `file` when it is not valid YAML. */
export function parseYaml(text: string, file: string): unknown {
  try {
    return Bun.YAML.parse(text);
  } catch (e) {
    fail(`${file}: invalid YAML: ${(e as Error).message}`);
  }
}

/** Parse YAML text and validate it as a whole config, with no root layers. */
export function parseConfig(text: string, file = CONFIG_FILE): ProjectConfig {
  return validateConfig(parseYaml(text, file), file);
}

export const configPath = (repoDir: string) => join(repoDir, CONFIG_FILE);

/** The root config, `<root>/config.yml`: settings that live outside the repos. */
export const ROOT_CONFIG_FILE = "config.yml";
export const rootConfigPath = () => join(root(), ROOT_CONFIG_FILE);
const ROOT_KEYS = ["version", "defaults", "repos"];

/**
 * The root config's layers. `defaults` goes under every repo's `overbridge.yml`; `repos.<name>` goes
 * over that repo's file. Both are partial configs in `overbridge.yml`'s format.
 */
export interface RootLayers {
  file: string;
  defaults?: Record<string, unknown>;
  repos: Record<string, Record<string, unknown>>;
}

/** Read and check `<root>/config.yml`. A missing or empty file has no layers. */
export function loadRootLayers(file = rootConfigPath()): RootLayers {
  const layers: RootLayers = { file, repos: {} };
  if (!existsSync(file)) return layers;
  const raw = parseYaml(readFileSync(file, "utf8"), file);
  if (raw === null || raw === undefined) return layers;
  if (!isObject(raw)) fail(`${file}: expected a mapping at the top level`);

  const p = new Problems();
  p.unknownKeys(raw, ROOT_KEYS, "");
  if (raw.version !== undefined && raw.version !== CONFIG_VERSION) {
    p.add("version", `unsupported version ${JSON.stringify(raw.version)} (this overbridge reads version ${CONFIG_VERSION})`);
  }
  if (raw.defaults !== undefined && raw.defaults !== null) {
    if (isObject(raw.defaults)) layers.defaults = raw.defaults;
    else p.add("defaults", "expected a mapping in overbridge.yml's format");
  }
  if (raw.repos !== undefined && raw.repos !== null) {
    if (!isObject(raw.repos)) p.add("repos", "expected a mapping of repo name to settings");
    else
      for (const [name, layer] of Object.entries(raw.repos)) {
        if (isObject(layer)) layers.repos[name] = layer;
        else if (layer !== null) p.add(`repos.${name}`, "expected a mapping in overbridge.yml's format");
      }
  }
  if (p.list.length) fail(`${file}:\n${p.list.map((line) => `  ${line}`).join("\n")}`);

  if (layers.defaults) validateConfig(layers.defaults, `${file} (defaults)`, { partial: true, root: true });
  for (const [name, layer] of Object.entries(layers.repos)) validateConfig(layer, `${file} (repos.${name})`, { partial: true, root: true });
  return layers;
}

/**
 * Lay `over` on `base`: mappings merge key by key, anything else (lists included) replaces, and a
 * `null` in `over` removes the key.
 */
export function overlay(base: unknown, over: unknown): unknown {
  if (over === undefined || over === null) return base;
  if (!isObject(base) || !isObject(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === null) delete out[key];
    else out[key] = overlay(out[key], value);
  }
  return out;
}

/**
 * The config for `repo`: built-in defaults, then the root `defaults`, then the repo's own file (`repoRaw`,
 * parsed from `file`; undefined when there is none), then the root's `repos.<repo>`.
 */
export function resolveConfig(repoRaw: unknown, repo: string | undefined, file: string, layers = loadRootLayers()): ProjectConfig {
  if (repoRaw !== undefined && repoRaw !== null) validateConfig(repoRaw, file, { partial: true });
  const over = repo === undefined ? undefined : layers.repos[repo];
  const sources = [
    layers.defaults && `${layers.file} (defaults)`,
    repoRaw !== undefined && repoRaw !== null && file,
    over && `${layers.file} (repos.${repo})`,
  ].filter(Boolean);
  // the repo file was checked for root-only keys above, so any left come from the root config
  return validateConfig(overlay(overlay(layers.defaults, repoRaw), over), sources.join(" + ") || file, { root: true });
}

/** Load a config file for `repo` with the root layers applied. A missing file means the root layers alone. */
export function loadConfigFile(file: string, repo: string | undefined): ProjectConfig {
  const raw = existsSync(file) ? parseYaml(readFileSync(file, "utf8"), file) : undefined;
  return resolveConfig(raw, repo, file);
}

/**
 * Load `<repoDir>/overbridge.yml` with the root layers applied. `repo` defaults to the repo name of the
 * worktree `repoDir` is in; outside a workspace only the root `defaults` apply.
 */
export function loadRepoConfig(repoDir: string, repo = repoOf(repoDir)): ProjectConfig {
  return loadConfigFile(configPath(repoDir), repo);
}

/** Config for every repo checked out in `workspace`, keyed by repo name. */
export function loadWorkspaceConfigs(workspace: string, repos: string[]): Record<string, ProjectConfig> {
  return Object.fromEntries(repos.map((repo) => [repo, loadRepoConfig(worktreePath(workspace, repo), repo)]));
}

const camel = (key: string) => key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * Look up a dotted key (`commands.test`, `project-management.name`, `review.local-dir`) in a resolved
 * config. Keys use the file's spelling. An `x-<name>` key reads an extension's settings as written.
 * Returns undefined when the key is unset.
 */
export function getConfigValue(config: ProjectConfig, key: string): unknown {
  const [first = "", ...rest] = key.split(".");
  const extension = isExtensionKey(first);
  let node: unknown = extension ? config.extensions?.[first] : config[camel(first) as keyof ProjectConfig];
  for (const segment of rest) {
    if (!isObject(node)) return;
    node = node[extension ? segment : camel(segment)];
  }
  return node;
}
