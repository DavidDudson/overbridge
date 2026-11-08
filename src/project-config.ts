import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { worktreePath } from "./paths";
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

/** One launchable app. Only the shape is checked here; semantics belong to the apps module. */
export interface AppConfig {
  id: string;
  start: string;
  [key: string]: unknown;
}

/** Shell commands skills run to check a change. Each is optional; a missing one means the repo has none. */
export const COMMAND_NAMES = ["lint", "typecheck", "test", "build", "format"] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];
export type Commands = Partial<Record<CommandName, string>>;

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
  apps: AppConfig[];
  commands: Commands;
  review: ReviewConfig;
  ide?: Ide;
}

export const defaultConfig = (): ProjectConfig => ({
  version: CONFIG_VERSION,
  apps: [],
  commands: {},
  review: { exclude: [], localDir: DEFAULT_PERSONA_DIR },
});

const TOP_KEYS = ["version", "project-management", "apps", "commands", "review", "ide"];
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

class Problems {
  readonly list: string[] = [];
  add(path: string, message: string) {
    this.list.push(path ? `${path}: ${message}` : message);
  }
  /** Report every key of `obj` not in `allowed`, suggesting the nearest valid key. */
  unknownKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string) {
    for (const key of Object.keys(obj)) {
      if (allowed.includes(key)) continue;
      const hint = suggest(key, allowed);
      this.add(path ? `${path}.${key}` : key, `unknown key${hint ? `, did you mean '${hint}'?` : ` (allowed: ${allowed.join(", ")})`}`);
    }
  }
  string(obj: Record<string, unknown>, key: string, path: string, required: boolean): string | undefined {
    const at = path ? `${path}.${key}` : key;
    const v = obj[key];
    if (v === undefined || v === null) {
      if (required) this.add(at, "required");
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

/** Validate parsed YAML. Throws one error naming `file` and every offending key. */
export function validateConfig(raw: unknown, file = CONFIG_FILE): ProjectConfig {
  if (raw === null || raw === undefined) return defaultConfig();
  const p = new Problems();
  const config = defaultConfig();
  if (!isObject(raw)) fail(`${file}: expected a mapping at the top level`);

  p.unknownKeys(raw, TOP_KEYS, "");

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
        p.unknownKeys(entry, APP_KEYS, path);
        const id = p.string(entry, "id", path, true);
        const start = p.string(entry, "start", path, true);
        if (id && seen.has(id)) p.add(`${path}.id`, `duplicate app id '${id}'`);
        if (id) seen.add(id);
        if (id && start) config.apps.push({ ...entry, id, start });
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

/** Parse YAML text and validate it. */
export function parseConfig(text: string, file = CONFIG_FILE): ProjectConfig {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch (e) {
    fail(`${file}: invalid YAML: ${(e as Error).message}`);
  }
  return validateConfig(raw, file);
}

export const configPath = (repoDir: string) => join(repoDir, CONFIG_FILE);

/** Load `<repoDir>/overbridge.yml`. A missing file means defaults, not an error. */
export function loadRepoConfig(repoDir: string): ProjectConfig {
  const file = configPath(repoDir);
  if (!existsSync(file)) return defaultConfig();
  return parseConfig(readFileSync(file, "utf8"), file);
}

/** Config for every repo checked out in `workspace`, keyed by repo name. */
export function loadWorkspaceConfigs(workspace: string, repos: string[]): Record<string, ProjectConfig> {
  return Object.fromEntries(repos.map((repo) => [repo, loadRepoConfig(worktreePath(workspace, repo))]));
}

const camel = (key: string) => key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * Look up a dotted key (`commands.test`, `project-management.name`, `review.local-dir`) in a resolved
 * config. Keys use the file's spelling. Returns undefined when the key is unset.
 */
export function getConfigValue(config: ProjectConfig, key: string): unknown {
  let node: unknown = config;
  for (const segment of key.split(".")) {
    if (!isObject(node)) return;
    node = node[camel(segment)];
  }
  return node;
}
