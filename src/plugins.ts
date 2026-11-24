import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isJsonObject, isJsonString, type JsonValue } from "./json";
import { modsSettings } from "./mods";
import { packageRoot } from "./paths";
import { log, run } from "./util";

const MARKETPLACE_FILE = join(".claude-plugin", "marketplace.json");

type Marketplace = { name: string; plugins: { name: string; source: string }[] };

/** A marketplace Claude already knows, as `claude plugin marketplace list --json` prints it. */
export type KnownMarketplace = { name: string; source: string; path?: string; repo?: string; url?: string };

/** The marketplace `value` describes, or undefined when it has no name or plugin list. */
function decodeMarketplace(value: JsonValue | undefined): Marketplace | undefined {
  if (!isJsonObject(value) || !isJsonString(value.name) || !Array.isArray(value.plugins)) return undefined;
  const plugins: Marketplace["plugins"] = [];

  for (const p of value.plugins) {
    if (isJsonObject(p) && isJsonString(p.name) && isJsonString(p.source)) plugins.push({ name: p.name, source: p.source });
  }

  return { name: value.name, plugins };
}

/** The overbridge marketplace shipped in the installed package, or why it can't be read. */
function readMarketplace(root: string): Marketplace | string {
  const file = join(root, MARKETPLACE_FILE);

  if (!existsSync(file)) {
    return `${file} is missing, so this overbridge install has no Claude plugins`;
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));

    return decodeMarketplace(isJsonObject(parsed) ? parsed : undefined) ?? `${file} has no marketplace name and plugin list`;
  } catch (e) {
    return `${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Claude settings that register the installed package as a directory marketplace and enable all its plugins.
 * Relative-path plugins load in place, so the skills always match the running overbridge. Empty when the
 * package ships no marketplace: `pluginProblems` reports that.
 */
export function pluginSettings(root = packageRoot()): PluginSettings {
  const marketplace = readMarketplace(root);

  if (isJsonString(marketplace)) {
    return {};
  }

  return {
    extraKnownMarketplaces: { [marketplace.name]: { source: { source: "directory", path: root } } },
    enabledPlugins: Object.fromEntries(marketplace.plugins.map((p) => [`${p.name}@${marketplace.name}`, true])),
  };
}

/** Marketplace and enable settings, as Claude reads them from settings.json or `--settings`. */
export interface PluginSettings {
  extraKnownMarketplaces?: Record<string, { source: { source: string; path: string } }>;
  enabledPlugins?: Record<string, boolean>;
}

/** The overbridge plugins plus the user's mods (`overbridge mods`): what a workspace Claude loads. */
export function workspacePluginSettings(base: PluginSettings = pluginSettings(), mods: PluginSettings = modsSettings(undefined, log)): PluginSettings {
  if (!mods.extraKnownMarketplaces) {
    return base;
  }

  return {
    extraKnownMarketplaces: { ...base.extraKnownMarketplaces, ...mods.extraKnownMarketplaces },
    enabledPlugins: { ...base.enabledPlugins, ...mods.enabledPlugins },
  };
}

/** Marketplaces Claude knows, or none when `claude` is missing or the call fails: a probe never blocks a start. */
export function knownMarketplaces(): KnownMarketplace[] {
  const r = run(["claude", "plugin", "marketplace", "list", "--json"]);

  if (!r.ok) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(r.stdout);
    const known: KnownMarketplace[] = [];

    for (const m of Array.isArray(parsed) ? parsed : []) {
      if (!isJsonObject(m) || !isJsonString(m.name) || !isJsonString(m.source)) continue;
      const entry: KnownMarketplace = { name: m.name, source: m.source };

      if (isJsonString(m.path)) entry.path = m.path;

      if (isJsonString(m.repo)) entry.repo = m.repo;

      if (isJsonString(m.url)) entry.url = m.url;
      known.push(entry);
    }

    return known;
  } catch {
    return [];
  }
}

/** Problems that leave a new session without the overbridge skills, each with its fix. */
export type PluginProblems = { errors: string[]; warnings: string[] };

/**
 * Check the installed package can supply the plugins. A missing bundle is an error. A marketplace of the
 * same name registered from elsewhere is a warning: its skills still load, but they may not match this
 * overbridge.
 */
export function pluginProblems(root = packageRoot(), known: () => KnownMarketplace[] = knownMarketplaces): PluginProblems {
  const marketplace = readMarketplace(root);

  if (isJsonString(marketplace)) {
    return { errors: [`${marketplace}. Reinstall overbridge from a build that ships .claude-plugin/, plugin/ and plugin-review/.`], warnings: [] };
  }

  const missing = marketplace.plugins
    .map((p) => join(root, p.source))
    .filter((dir) => !existsSync(dir))
    .map((dir) => `plugin folder ${dir} is missing. Reinstall overbridge.`);

  const clash = known().find((m) => m.name === marketplace.name && !(m.source === "directory" && m.path === root));

  const warnings = clash
    ? [
        `Claude has a '${clash.name}' marketplace from ${clash.path ?? clash.repo ?? clash.url ?? clash.source}, not this install (${root}), so its skills may not match. ` +
          `Remove it with \`claude plugin marketplace remove ${clash.name}\`.`,
      ]
    : [];

  return { errors: missing, warnings };
}

/** Skills the overbridge skills build on. Each overbridge skill that needs one lists it in its `requires:` frontmatter. */
export const REQUIRED_SKILLS = ["gh-stack"];

/** Where Claude loads skills from: the user's skills folder and the `skills/` of each installed plugin. */
export function skillDirs(): string[] {
  const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const dirs = [join(config, "skills")];

  try {
    const installed: unknown = JSON.parse(readFileSync(join(config, "plugins", "installed_plugins.json"), "utf8"));
    const plugins = isJsonObject(installed) && isJsonObject(installed.plugins) ? installed.plugins : {};

    for (const entries of Object.values(plugins)) {
      for (const e of Array.isArray(entries) ? entries : []) {
        if (isJsonObject(e) && isJsonString(e.installPath) && e.installPath) dirs.push(join(e.installPath, "skills"));
      }
    }
  } catch {
    // no plugin list: the user skills folder is all there is
  }

  return dirs;
}

/** One error per required skill that no skills folder holds, each with its fix. */
export function requiredSkillProblems(required: string[] = REQUIRED_SKILLS, dirs: string[] = skillDirs()): string[] {
  return required.flatMap((name) =>
    dirs.some((d) => existsSync(join(d, name, "SKILL.md")))
      ? []
      : [`the '${name}' skill is not installed, and the overbridge skills depend on it. Install it (a skill folder with ${name}/SKILL.md under ${dirs[0]}).`],
  );
}
