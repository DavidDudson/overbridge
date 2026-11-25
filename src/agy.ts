/** What an agy workspace gets in place of Claude's settings. agy starts in the workspace folder, which holds no repo, so these files never land in a worktree. */
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isJsonObject, isJsonString, parseJson, type JsonObject } from "./json";
import { isInside, packageRoot, realPath, root, selfCommand, wsDir } from "./paths";
import { REQUIRED_SKILLS, requiredSkillProblems, skillDirs, type PluginProblems } from "./plugins";
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

/** agy's argv from a workspace agent's arguments: a prompt after `--` becomes `-i <prompt>`, agy's interactive first message. */
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

/** Workspace `ws`'s `hooks.json`. PreToolUse runs only the guard, which records the call too, since agy takes one decision per entry. */
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

/** One skill an agy workspace loads: its folder name and the folder it is copied from. */
export interface AgySkill {
  name: string;
  from: string;
}

const skillsIn = (dir: string): AgySkill[] =>
  existsSync(dir) ? readdirSync(dir).flatMap((name) => (existsSync(join(dir, name, "SKILL.md")) ? [{ name, from: join(dir, name) }] : [])) : [];

/** The skills of the package's plugins, then each required skill from the first folder holding it; the first skill of a name wins. */
export function agySkills(pkg = packageRoot(), required: readonly string[] = REQUIRED_SKILLS, dirs: readonly string[] = skillDirs()): AgySkill[] {
  const own = PLUGIN_FOLDERS.flatMap((p) => skillsIn(join(pkg, p, "skills")));

  const deps = required.flatMap((name): AgySkill[] => {
    const dir = dirs.find((d) => existsSync(join(d, name, "SKILL.md")));

    return dir ? [{ name, from: join(dir, name) }] : [];
  });

  return [...own, ...deps].filter((skill, i, all) => all.findIndex((s) => s.name === skill.name) === i);
}

/** The file in `.agents/skills` that lists the skill folders overbridge put there, so a re-scaffold removes only those. */
const SKILLS_MANIFEST = ".overbridge.json";

/** A manifest entry overbridge may remove: one folder name, never empty, `.`, `..` or a path, since the file can be edited by hand. */
const SKILL_NAME = /^\w[\w.-]*$/;

/** `path` and everything under it made writable by its owner, since a copy keeps a read-only source's modes (a Nix store). */
function makeWritable(path: string) {
  const stat = lstatSync(path);

  if (stat.isSymbolicLink()) {
    return;
  }

  chmodSync(path, stat.mode | (stat.isDirectory() ? 0o700 : 0o200));

  if (stat.isDirectory()) {
    readdirSync(path).forEach((name) => makeWritable(join(path, name)));
  }
}

/** Remove `path` and everything under it, read-only or not. */
function removeTree(path: string) {
  if (existsSync(path)) {
    makeWritable(path);
    rmSync(path, { recursive: true, force: true });
  }
}

function readManifest(dest: string): string[] {
  try {
    const parsed = parseJson(readFileSync(join(dest, SKILLS_MANIFEST), "utf8"));

    return Array.isArray(parsed) ? parsed.filter(isJsonString) : [];
  } catch {
    return [];
  }
}

/** Copy one skill folder into `dest` through a temporary sibling, so a failed copy leaves the old one in place. */
function copySkill(dest: string, { name, from }: AgySkill) {
  const tmp = join(dest, `.${name}.${process.pid}.tmp`);

  try {
    removeTree(tmp);
    cpSync(from, tmp, { recursive: true, dereference: true });
    makeWritable(tmp);
    removeTree(join(dest, name));
    renameSync(tmp, join(dest, name));
  } finally {
    removeTree(tmp);
  }
}

/**
 * Copy `skills` into `dest` (`.agents/skills`), replacing the ones overbridge copied before and leaving any other folder
 * alone, even one with a skill's name. agy loads a workspace's skills only from real folders inside it, not from paths outside it or symlinks.
 */
export function copyAgySkills(dest: string, skills: readonly AgySkill[]) {
  mkdirSync(dest, { recursive: true });
  const before = readManifest(dest).filter((name) => SKILL_NAME.test(name));
  const ours = skills.filter((s) => before.includes(s.name) || !existsSync(join(dest, s.name)));
  const names = ours.map((s) => s.name);
  const manifest = join(dest, SKILLS_MANIFEST);

  skills
    .filter((s) => !names.includes(s.name))
    .forEach((s) => log(`warning: ${join(dest, s.name)} was not copied by overbridge, so it is left as it is and overbridge's ${s.name} skill is not copied`));
  const record = (list: readonly string[]) => writeAtomic(manifest, `${JSON.stringify(list, null, 2)}\n`);
  const kept = before.filter((name) => names.includes(name));

  before.filter((name) => !names.includes(name)).forEach((name) => removeTree(join(dest, name)));
  record(kept);
  const done = [...kept];

  // each skill is listed once its copy is in place, so a failed copy never claims a folder overbridge did not write
  for (const skill of ours) {
    copySkill(dest, skill);

    if (!done.includes(skill.name)) {
      done.push(skill.name);
    }

    record(done);
  }
}

/** Problems that leave a new agy workspace without its agent, the overbridge skills or the skills they require, each with its fix. */
export function agyPluginProblems(pkg = packageRoot(), onPath = () => run(["which", AGY]).ok, skills = () => requiredSkillProblems()): PluginProblems {
  const errors = [
    ...(onPath() ? [] : [`${AGY} is not on PATH. Install the Antigravity CLI, or start the workspace with --agent claude.`]),
    ...PLUGIN_FOLDERS.flatMap((p) => {
      const dir = join(pkg, p, "skills");

      return existsSync(dir) ? [] : [`skills folder ${dir} is missing. Reinstall overbridge.`];
    }),
    ...skills(),
  ];

  return { errors, warnings: [] };
}

/** Write `file` through a sibling and a rename, so an agy starting at the same moment never reads half of it. */
function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** What an agy workspace's brief adds: agy starts above the repos, so repo commands need the repo's folder. */
export const agyBriefNote = (ws: string) => `
## Working directory

You start in the workspace folder (\`${wsDir(ws)}\`), which holds no repo. Run every repo command, including
\`overbridge config\`, \`item\`, \`ext\`, \`check\` and \`pr\`, from that repo's folder (\`${wsDir(ws)}/<repo>\`): pass it as the
command's working directory, since overbridge finds the repo's \`overbridge.yml\` from there.
`;

/** (Re)write the agy files for workspace `ws`, with `brief` as its AGENTS.md. Idempotent. */
export function scaffoldAgy(ws: string, brief: string) {
  const dir = join(wsDir(ws), AGY_DIR);
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, "hooks.json"), `${JSON.stringify(agyHooks(ws), null, 2)}\n`);
  copyAgySkills(join(dir, "skills"), agySkills());
  rmSync(join(dir, "skills.json"), { force: true });
  writeAtomic(join(wsDir(ws), AGY_BRIEF), `${brief}${agyBriefNote(ws)}`);
}

/** agy's user settings, where it lists the folders the user trusts (`trustedWorkspaces`). */
export const agySettingsPath = () => process.env.OVERBRIDGE_AGY_SETTINGS || join(homedir(), ".gemini", "antigravity-cli", "settings.json");

const TRUST_KEY = "trustedWorkspaces";

/** Overbridge only trusts folders it creates, which all sit strictly below the root. */
function ownedFolder(dir: string): string {
  const path = realPath(dir);

  const top = realPath(root());

  if (path === top || !isInside(path, top)) {
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
