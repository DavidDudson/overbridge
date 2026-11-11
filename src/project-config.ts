import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoOf, root, worktreePath } from "./paths";
import { fail, isRecord } from "./util";

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
  /** Branch name template; see `BRANCH_PLACEHOLDERS`. Unset means the provider's default. */
  branch?: string;
  /** Workspace name template; see `WORKSPACE_PLACEHOLDERS`. Unset means the provider's default. */
  workspace?: string;
  /** Item type (a Jira issue type or a GitHub label) to the `{type}` a branch name uses; `default` covers the rest. */
  branchTypes?: Record<string, string>;
  /** Issue type for new items (Jira). Unset means `Task`. */
  issueType?: string;
  /** JQL that narrows the work list's Jira query. Unset means `DEFAULT_WORKLIST_JQL`; empty means no narrowing. */
  worklistJql?: string;
  /** GitHub only: a Projects v2 board, `<owner>/<number>` or a bare number (the repo's owner), whose items replace "assigned to me". */
  worklistProject?: string;
  /** With `worklistProject`: the Status values to list. Unset means every status except Done. */
  worklistStatuses?: string[];
}

export const BRANCH_PLACEHOLDERS = ["id", "number", "slug", "type"] as const;
export const WORKSPACE_PLACEHOLDERS = ["id", "number", "repo"] as const;

/** Problems with a name template: unknown placeholders, and a missing `{id}`/`{number}` when one is required. */
export function templateProblems(template: string, allowed: readonly string[], needsId: boolean): string[] {
  const used = [...template.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]!);
  const problems = used.filter((p) => !allowed.includes(p)).map((p) => `unknown placeholder {${p}} (allowed: ${allowed.map((a) => `{${a}}`).join(", ")})`);
  if (needsId && !used.some((p) => p === "id" || p === "number")) problems.push("needs {id} or {number}, so a branch names its item");
  return problems;
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

/**
 * How to enter a repo's dev shell. `enter` is a command prefix (the command to run is appended). With `env`
 * (a command printing NUL-separated KEY=VALUE pairs, as `env -0` does) overbridge caches the resolved env,
 * keyed on the hash of the `key` files, and runs commands directly with it instead of through `enter`.
 */
export interface ShellSpec {
  enter: string;
  env?: string;
  /** Repo-relative files whose contents key the cached env. */
  key: string[];
}

/** How `overbridge check` queues a command: when it may start, and when it is killed. */
export interface CheckQueue {
  /** Start only while the 1-minute load average is under this share of the cores; over 100 allows more load than cores. */
  maxLoadPercent: number;
  /** At most this many runs at once; unset leaves the load as the only limit. */
  maxParallel?: number;
  /** Kill the run after this long, busy or not. */
  timeoutSeconds: number;
  /** Kill the run once its process group has used no CPU for this long. */
  stallSeconds: number;
  /** Give up waiting for a turn after this long. */
  waitSeconds: number;
}

export const defaultCheckQueue = (): CheckQueue => ({ maxLoadPercent: 70, timeoutSeconds: 180, stallSeconds: 300, waitSeconds: 900 });

export const DEFAULT_PERSONA_DIR = ".overbridge/personas";

export interface ReviewConfig {
  /** Reviewer personas to run; unset means auto-select by diff signals. */
  personas?: string[];
  /** Personas to skip, applied after `personas` or auto-selection. */
  exclude: string[];
  /** Repo-relative directory of repo-local personas. */
  localDir: string;
}

/** What `overbridge icebox` may delete with `--prune` (repo-relative paths git ignores, such as `node_modules`), and when the sidebar suggests it. */
export interface IceboxConfig {
  prune: string[];
  /** Suggest iceboxing a workspace whose PRs are all drafts and idle this many days; unset turns the suggestion off. */
  idleDays?: number;
}

export interface ProjectConfig {
  version: typeof CONFIG_VERSION;
  projectManagement?: ProjectManagement;
  apps: AppSpec[];
  commands: Commands;
  review: ReviewConfig;
  ide?: Ide;
  /** The repo's dev shell, if it declares one. */
  shell?: ShellSpec;
  checkQueue: CheckQueue;
  icebox: IceboxConfig;
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
  checkQueue: defaultCheckQueue(),
  icebox: { prune: [] },
  buttons: [],
});

const TOP_KEYS = ["version", "project-management", "apps", "commands", "review", "ide", "shell", "check-queue", "icebox", "hooks", "buttons"];
const SHELL_KEYS = ["enter", "env", "key"];
const CHECK_QUEUE_KEYS = ["max-load-percent", "max-parallel", "timeout-seconds", "stall-seconds", "wait-seconds"];
const ICEBOX_KEYS = ["prune", "idle-days"];
const REVIEW_KEYS = ["personas", "exclude", "local-dir"];
const PM_KEYS = ["name", "project", "url", "tech-debt", "branch", "workspace", "branch-types", "issue-type", "worklist-jql", "worklist-project", "worklist-statuses"];
const APP_KEYS = ["id", "label", "dir", "start", "stop", "prepare", "ports", "ready", "open", "when"];

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
    const at = path ? `${path}.${key}` : key;
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
  /** A whole number from 1 to `max`, or undefined when the key is absent. */
  positiveInt(obj: Record<string, unknown>, key: string, path: string, max = Number.MAX_SAFE_INTEGER): number | undefined {
    const at = path ? `${path}.${key}` : key;
    const v = obj[key];
    if (v === undefined || v === null) return;
    if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > max) {
      this.add(at, `expected a whole number from 1${max === Number.MAX_SAFE_INTEGER ? " up" : ` to ${max}`} (got ${JSON.stringify(v)})`);
      return;
    }
    return v as number;
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
    if (!isRecord(r)) p.add(`${path}.ready`, "expected a mapping with http or tcp");
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

/** `path` without a leading `./` or trailing `/`, so a configured prune path compares equal to what git lists. */
export const normalizePrunePath = (path: string): string => path.replace(/^(\.\/)+/, "").replace(/\/+$/, "");

/** A path below the repo root: no `..`, no absolute path, no glob or pathspec magic, and never git's or the workspace's own files. */
export function isPrunablePath(path: string): boolean {
  const parts = normalizePrunePath(path).split("/");
  return !path.startsWith("/") && !parts.includes("") && !parts.includes("..") && !parts.includes(".") && ![".git", ".claude"].includes(parts[0]!) && !/[*?[\\:]/.test(path);
}

/**
 * Validate parsed YAML. Throws one error naming `file` and every offending key. With `partial`, `raw` is
 * one layer of a merged config, so a missing required key is not an error. With `root`, the root-only keys
 * (`hooks`, `buttons`) are allowed.
 */
export function validateConfig(raw: unknown, file = CONFIG_FILE, { partial = false, root = false } = {}): ProjectConfig {
  if (raw === null || raw === undefined) return defaultConfig();
  const p = new Problems(partial);
  const config = defaultConfig();
  if (!isRecord(raw)) fail(`${file}: expected a mapping at the top level`);

  p.unknownKeys(raw, TOP_KEYS, "", true);
  const extensions = Object.entries(raw).filter(([key]) => isExtensionKey(key));
  if (extensions.length) config.extensions = Object.fromEntries(extensions);

  if (raw.version !== undefined && raw.version !== CONFIG_VERSION) {
    p.add("version", `unsupported version ${JSON.stringify(raw.version)} (this overbridge reads version ${CONFIG_VERSION})`);
  }

  const pm = raw["project-management"];
  if (pm !== undefined && pm !== null) {
    if (!isRecord(pm)) p.add("project-management", "expected a mapping with name and project");
    else {
      p.unknownKeys(pm, PM_KEYS, "project-management");
      const name = p.oneOf(p.string(pm, "name", "project-management", true), PM_NAMES, "project-management.name");
      const project = p.string(pm, "project", "project-management", true);
      const url = p.string(pm, "url", "project-management", false);
      const techDebt = p.string(pm, "tech-debt", "project-management", false);
      const branch = p.string(pm, "branch", "project-management", false);
      if (branch) for (const problem of templateProblems(branch, BRANCH_PLACEHOLDERS, true)) p.add("project-management.branch", problem);
      const workspace = p.string(pm, "workspace", "project-management", false);
      if (workspace) for (const problem of templateProblems(workspace, WORKSPACE_PLACEHOLDERS, true)) p.add("project-management.workspace", problem);
      const issueType = p.string(pm, "issue-type", "project-management", false);
      const worklistJql = pm["worklist-jql"] === "" ? "" : p.string(pm, "worklist-jql", "project-management", false);
      const worklistProject = p.string(pm, "worklist-project", "project-management", false);
      if (worklistProject && !/^(?:[\w.-]+\/)?\d+$/.test(worklistProject)) p.add("project-management.worklist-project", "expected <owner>/<number> or a project number, e.g. DavidDudson/2");
      const worklistStatuses = p.stringList(pm, "worklist-statuses", "project-management");
      let branchTypes: Record<string, string> | undefined;
      const types = pm["branch-types"];
      if (types !== undefined && types !== null) {
        if (!isRecord(types)) p.add("project-management.branch-types", "expected a mapping of item type to branch type");
        else {
          branchTypes = {};
          for (const type of Object.keys(types)) {
            const value = p.string(types, type, "project-management.branch-types", true);
            if (value) branchTypes[type] = value;
          }
        }
      }
      if (name && project) {
        config.projectManagement = {
          name,
          project,
          ...(url ? { url } : {}),
          ...(techDebt ? { techDebt } : {}),
          ...(branch ? { branch } : {}),
          ...(workspace ? { workspace } : {}),
          ...(branchTypes ? { branchTypes } : {}),
          ...(issueType ? { issueType } : {}),
          ...(worklistJql !== undefined ? { worklistJql } : {}),
          ...(worklistProject ? { worklistProject } : {}),
          ...(worklistStatuses ? { worklistStatuses } : {}),
        };
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
        if (!isRecord(entry)) return p.add(path, "expected a mapping");
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
    else if (!isRecord(hooks)) p.add("hooks", "expected a mapping of hook name to a command or a list of commands");
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
        if (!isRecord(entry)) return p.add(at, "expected a mapping");
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
    if (!isRecord(commands)) p.add("commands", "expected a mapping of command name to shell command");
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
    if (!isRecord(review)) p.add("review", "expected a mapping");
    else {
      p.unknownKeys(review, REVIEW_KEYS, "review");
      const personas = p.stringList(review, "personas", "review");
      if (personas) config.review.personas = personas;
      config.review.exclude = p.stringList(review, "exclude", "review") ?? [];
      config.review.localDir = p.string(review, "local-dir", "review", false) ?? DEFAULT_PERSONA_DIR;
    }
  }

  const icebox = raw.icebox;
  if (icebox !== undefined && icebox !== null) {
    if (!isRecord(icebox)) p.add("icebox", "expected a mapping with prune, idle-days");
    else {
      p.unknownKeys(icebox, ICEBOX_KEYS, "icebox");
      const prune = p.stringList(icebox, "prune", "icebox") ?? [];
      for (const path of prune) {
        if (!isPrunablePath(path)) p.add("icebox.prune", `'${path}' must be a path inside the repo, such as node_modules or target`);
      }
      config.icebox.prune = prune;
      const idleDays = p.positiveInt(icebox, "idle-days", "icebox");
      if (idleDays !== undefined) config.icebox.idleDays = idleDays;
    }
  }

  const ide = p.oneOf(p.string(raw, "ide", "", false), IDES, "ide");
  if (ide) config.ide = ide;

  const shell = raw.shell;
  if (shell !== undefined && shell !== null) {
    if (typeof shell === "string") {
      if (shell === "") p.add("shell", "expected a non-empty string or a mapping");
      else config.shell = { enter: shell, key: [] };
    } else if (!isRecord(shell)) p.add("shell", "expected a command prefix or a mapping with enter, env, key");
    else {
      p.unknownKeys(shell, SHELL_KEYS, "shell");
      const enter = p.string(shell, "enter", "shell", true);
      const env = p.string(shell, "env", "shell", false);
      const key = p.stringList(shell, "key", "shell") ?? [];
      if (key.length && !env) p.add("shell.key", "needs shell.env: the key only invalidates a cached env");
      if (enter) config.shell = { enter, ...(env ? { env } : {}), key };
    }
  }

  const checkQueue = raw["check-queue"];
  if (checkQueue !== undefined && checkQueue !== null) {
    if (!isRecord(checkQueue)) p.add("check-queue", `expected a mapping with ${CHECK_QUEUE_KEYS.join(", ")}`);
    else {
      p.unknownKeys(checkQueue, CHECK_QUEUE_KEYS, "check-queue");
      const set = (value: number | undefined, field: keyof CheckQueue) => {
        if (value !== undefined) config.checkQueue = { ...config.checkQueue, [field]: value };
      };
      set(p.positiveInt(checkQueue, "max-load-percent", "check-queue"), "maxLoadPercent");
      set(p.positiveInt(checkQueue, "max-parallel", "check-queue"), "maxParallel");
      set(p.positiveInt(checkQueue, "timeout-seconds", "check-queue"), "timeoutSeconds");
      set(p.positiveInt(checkQueue, "stall-seconds", "check-queue"), "stallSeconds");
      set(p.positiveInt(checkQueue, "wait-seconds", "check-queue"), "waitSeconds");
    }
  }

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
const ROOT_KEYS = ["version", "defaults", "repos", "skill-extensions", "guard", "github-orgs"];
const GUARD_KEYS = ["read-paths", "deny"];

/**
 * Additions to the workspace guard, from the root `config.yml` only. They can only tighten it, apart
 * from `readPaths`, which lets a workspace read (never write) the given paths under the root.
 */
export interface GuardConfig {
  /** Paths, absolute or `~/`-relative, that a workspace may read even though they are under the root. */
  readPaths: string[];
  /** Extra Bash commands to block, with the reason shown to Claude. */
  deny: { pattern: RegExp; reason: string }[];
}

/**
 * The root config's layers. `defaults` goes under every repo's `overbridge.yml`; `repos.<name>` goes
 * over that repo's file. Both are partial configs in `overbridge.yml`'s format.
 */
export interface RootLayers {
  file: string;
  defaults?: Record<string, unknown>;
  repos: Record<string, Record<string, unknown>>;
  /** Directories of skill extension files (`<dir>/<skill>/<phase>.md`), as written: absolute, `~/` or root-relative. */
  skillExtensions: string[];
  guard: GuardConfig;
  /** GitHub owners the `@prs` and `@reviews` tabs search. Empty means every owner. */
  githubOrgs: string[];
}

/** Read and check `<root>/config.yml`. A missing or empty file has no layers. */
export function loadRootLayers(file = rootConfigPath()): RootLayers {
  const layers: RootLayers = { file, repos: {}, skillExtensions: [], guard: { readPaths: [], deny: [] }, githubOrgs: [] };
  if (!existsSync(file)) return layers;
  const raw = parseYaml(readFileSync(file, "utf8"), file);
  if (raw === null || raw === undefined) return layers;
  if (!isRecord(raw)) fail(`${file}: expected a mapping at the top level`);

  const p = new Problems();
  p.unknownKeys(raw, ROOT_KEYS, "");
  if (raw.version !== undefined && raw.version !== CONFIG_VERSION) {
    p.add("version", `unsupported version ${JSON.stringify(raw.version)} (this overbridge reads version ${CONFIG_VERSION})`);
  }
  if (raw.defaults !== undefined && raw.defaults !== null) {
    if (isRecord(raw.defaults)) layers.defaults = raw.defaults;
    else p.add("defaults", "expected a mapping in overbridge.yml's format");
  }
  if (raw.repos !== undefined && raw.repos !== null) {
    if (!isRecord(raw.repos)) p.add("repos", "expected a mapping of repo name to settings");
    else
      for (const [name, layer] of Object.entries(raw.repos)) {
        if (isRecord(layer)) layers.repos[name] = layer;
        else if (layer !== null) p.add(`repos.${name}`, "expected a mapping in overbridge.yml's format");
      }
  }
  layers.skillExtensions = p.stringList(raw, "skill-extensions", "") ?? [];
  layers.githubOrgs = p.stringList(raw, "github-orgs", "") ?? [];
  if (raw.guard !== undefined && raw.guard !== null) {
    if (!isRecord(raw.guard)) p.add("guard", "expected a mapping with read-paths and deny");
    else {
      p.unknownKeys(raw.guard, GUARD_KEYS, "guard");
      layers.guard.readPaths = p.stringList(raw.guard, "read-paths", "guard") ?? [];
      const deny = raw.guard.deny;
      if (deny !== undefined && deny !== null) {
        if (!Array.isArray(deny)) p.add("guard.deny", "expected a list of { pattern, reason }");
        else
          deny.forEach((rule, i) => {
            const at = `guard.deny[${i}]`;
            if (!isRecord(rule)) return p.add(at, "expected a mapping with pattern and reason");
            p.unknownKeys(rule, ["pattern", "reason"], at);
            const source = p.string(rule, "pattern", at, true);
            const reason = p.string(rule, "reason", at, true);
            if (!source || !reason) return;
            try {
              layers.guard.deny.push({ pattern: new RegExp(source), reason });
            } catch (e) {
              p.add(`${at}.pattern`, `not a valid regular expression: ${(e as Error).message}`);
            }
          });
      }
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
  if (!isRecord(base) || !isRecord(over)) return over;
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
    if (!isRecord(node)) return;
    node = node[extension ? segment : camel(segment)];
  }
  return node;
}
