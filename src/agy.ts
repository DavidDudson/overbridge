/**
 * What a workspace running Antigravity CLI (`agy`) gets in place of Claude's settings: agy starts in the
 * workspace folder, which holds no repo, so the files there apply to that one workspace and never land in a
 * worktree. `AGENTS.md` carries the workspace brief, `.agents/hooks.json` the guard and the agent-state hook,
 * and `.agents/skills.json` points at the overbridge skills in the installed package.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isJsonObject, isJsonString, parseJson, type JsonObject } from "./json";
import { isInside, packageRoot, realPath, root, selfCommand, wsDir } from "./paths";
import { REQUIRED_SKILLS, skillDirs, type PluginProblems } from "./plugins";
import { fail, log, run, shellQuote } from "./util";

export const AGY = "agy";

/** agy's customization folder inside the workspace. */
export const AGY_DIR = ".agents";

/** The instruction file agy reads from its start folder up. */
export const AGY_BRIEF = "AGENTS.md";

/** Name of overbridge's entry in `hooks.json`; agy keys each set of hooks by name. */
const HOOK_NAME = "overbridge";

/** Plugin folders in the package, each with a `skills/` folder. */
const PLUGIN_FOLDERS = ["plugin", "plugin-review"];

/**
 * agy's argv from the arguments overbridge passes a workspace agent: `--continue` resumes, and a prompt after
 * `--` becomes `-i <prompt>`, which agy sends as the first message and stays interactive.
 */
export function agyArgs(extra: readonly string[]): string[] {
  const cut = extra.indexOf("--");
  const flags = cut < 0 ? extra : extra.slice(0, cut);
  const prompt = cut < 0 ? "" : extra.slice(cut + 1).join(" ");

  return [AGY, ...flags, ...(prompt ? ["-i", prompt] : [])];
}

/** One agy hook handler: overbridge's command, with the workspace in its environment so it never depends on agy passing its own on. */
const handler = (ws: string, sub: string[]) => ({
  type: "command",
  command: ["env", `OVERBRIDGE_NAME=${ws}`, `OVERBRIDGE_ROOT=${root()}`, ...selfCommand(), ...sub].map(shellQuote).join(" "),
  timeout: 30,
});

/**
 * Workspace `ws`'s `hooks.json`: the guard on every tool call (it also records the call, since agy takes one
 * decision per entry), and the agent-state hook on the other events agy has.
 */
export function agyHooks(ws: string) {
  const record = handler(ws, ["hook", "--agy"]);

  return {
    [HOOK_NAME]: {
      PreToolUse: [{ matcher: "*", hooks: [handler(ws, ["guard", "--agy"])] }],
      PostToolUse: [{ matcher: "*", hooks: [record] }],
      SessionStart: [record],
      PreInvocation: [record],
      Stop: [record],
    },
  };
}

/** One folder agy scans for skills; `include_only` limits it to the named skills. */
export interface SkillsEntry {
  path: string;
  include_only?: string[];
}

/** agy's `skills.json`: the folders it scans for skills. */
export interface SkillsJson {
  entries: SkillsEntry[];
}

/** The `skills/` folders of the package's plugins, as `skills.json` entries, plus the folders holding the skills they require. */
export function agySkills(pkg = packageRoot(), required: readonly string[] = REQUIRED_SKILLS, dirs: readonly string[] = skillDirs()): SkillsJson {
  const own = PLUGIN_FOLDERS.flatMap((p): SkillsEntry[] => {
    const path = join(pkg, p, "skills");

    return existsSync(path) ? [{ path }] : [];
  });

  const deps = dirs.flatMap((path): SkillsEntry[] => (required.some((name) => existsSync(join(path, name, "SKILL.md"))) ? [{ path, include_only: [...required] }] : []));

  return { entries: [...own, ...deps] };
}

/** Problems that leave a new agy workspace without its agent or the overbridge skills, each with its fix. */
export function agyPluginProblems(pkg = packageRoot(), onPath = () => run(["which", AGY]).ok): PluginProblems {
  const errors = [
    ...(onPath() ? [] : [`${AGY} is not on PATH. Install the Antigravity CLI, or start the workspace with --agent claude.`]),
    ...PLUGIN_FOLDERS.flatMap((p) => {
      const dir = join(pkg, p, "skills");

      return existsSync(dir) ? [] : [`skills folder ${dir} is missing. Reinstall overbridge.`];
    }),
  ];

  return { errors, warnings: [] };
}

/** Write `file` through a sibling and a rename, so an agy starting at the same moment never reads half of it. */
function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** (Re)write the agy files for workspace `ws`, with `brief` as its AGENTS.md. Idempotent. */
export function scaffoldAgy(ws: string, brief: string) {
  const dir = join(wsDir(ws), AGY_DIR);
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, "hooks.json"), `${JSON.stringify(agyHooks(ws), null, 2)}\n`);
  writeAtomic(join(dir, "skills.json"), `${JSON.stringify(agySkills(), null, 2)}\n`);
  writeAtomic(join(wsDir(ws), AGY_BRIEF), brief);
}

/** agy's user settings, where it lists the folders the user trusts (`trustedWorkspaces`). */
export const agySettingsPath = () => process.env.OVERBRIDGE_AGY_SETTINGS || join(homedir(), ".gemini", "antigravity-cli", "settings.json");

const TRUST_KEY = "trustedWorkspaces";

/** Overbridge only trusts folders it creates, which all sit strictly below the root. */
function ownedFolder(dir: string): string {
  const path = realPath(dir);

  if (path === realPath(root()) || !isInside(path, root())) {
    fail(`refusing to change agy trust for ${path}: it is not a workspace folder under ${root()}`);
  }

  return path;
}

function readSettings(file: string): JsonObject | undefined {
  if (!existsSync(file)) return {};

  try {
    const parsed = parseJson(readFileSync(file, "utf8"));

    if (isJsonObject(parsed)) return parsed;
  } catch {
    // reported below
  }

  log(`warning: ${file} is not a JSON object; left it alone, so agy may ask to trust this workspace`);

  return undefined;
}

/** Change only agy's trusted folder list, through `change`; agy rewrites this file while it runs, so the write is one rename. */
function updateTrust(dir: string, change: (list: string[], path: string) => string[]) {
  const path = ownedFolder(dir);
  const file = agySettingsPath();
  const settings = readSettings(file);

  if (!settings) return;
  const raw = settings[TRUST_KEY];
  const list = Array.isArray(raw) ? raw.filter(isJsonString) : [];
  const next = change(list, path);

  if (next === list) return;
  mkdirSync(join(file, ".."), { recursive: true });
  writeAtomic(file, `${JSON.stringify({ ...settings, [TRUST_KEY]: next }, null, 2)}\n`);
}

/** Add workspace folder `dir` to agy's trusted folders, so it loads the workspace's hooks without asking. */
export const agyTrust = (dir: string) => updateTrust(dir, (list, path) => (list.includes(path) ? list : [...list, path]));

/** Drop workspace folder `dir` from agy's trusted folders. */
export const agyUntrust = (dir: string) => updateTrust(dir, (list, path) => (list.includes(path) ? list.filter((p) => p !== path) : list));
