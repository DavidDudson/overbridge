import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isInside, root } from "./paths";
import { fail, isRecord, log } from "./util";

type Project = Record<string, unknown>;
type ClaudeConfig = { projects?: Record<string, Project> } & Record<string, unknown>;

const TRUST_KEY = "hasTrustDialogAccepted";

/** Claude's global config, where it records which folders the user has trusted. */
export const claudeConfigPath = () => join(process.env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json");

const realPath = (dir: string) => (existsSync(dir) ? realpathSync(dir) : dir);

/** Overbridge only trusts folders it creates, which all sit strictly below the root. */
function ownedFolder(dir: string): string {
  const path = realPath(dir);
  if (path === root() || !isInside(path, root())) {
    fail(`refusing to change Claude trust for ${path}: it is not a workspace folder under ${root()}`);
  }
  return path;
}

function readConfig(file: string): ClaudeConfig | undefined {
  if (!existsSync(file)) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (isRecord(parsed)) {
      return parsed as ClaudeConfig;
    }
  } catch {
    // reported below
  }
  log(`warning: ${file} is not a JSON object; left it alone, so Claude may ask to trust this workspace`);
  return undefined;
}

/** Claude rewrites this file while it runs, so write a sibling and rename it over in one step. */
function writeConfig(file: string, config: ClaudeConfig) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, undefined, 2)}\n`);
  renameSync(tmp, file);
}

function updateProjects(dir: string, change: (projects: Record<string, Project>, path: string) => Record<string, Project>) {
  const path = ownedFolder(dir);
  const file = claudeConfigPath();
  const config = readConfig(file);
  if (!config) {
    return;
  }
  const projects = config.projects ?? {};
  const next = change(projects, path);
  if (next !== projects) {
    writeConfig(file, { ...config, projects: next });
  }
}

/** Mark workspace folder `dir` as trusted in Claude, so a session started there skips the trust prompt. */
export const trustFolder = (dir: string) =>
  updateProjects(dir, (projects, path) =>
    projects[path]?.[TRUST_KEY] === true ? projects : { ...projects, [path]: { ...projects[path], [TRUST_KEY]: true } },
  );

/** Drop the trust overbridge recorded for workspace folder `dir`, and the folder's entry once nothing else is in it. */
export const untrustFolder = (dir: string) =>
  updateProjects(dir, (projects, path) => {
    const entry = projects[path];
    if (!entry || !(TRUST_KEY in entry)) {
      return projects;
    }
    const { [TRUST_KEY]: _dropped, ...rest } = entry;
    const { [path]: _old, ...others } = projects;
    return Object.keys(rest).length ? { ...others, [path]: rest } : others;
  });
