import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_LEADER, type Leader, parseLeader } from "./leader";
import { reposFile } from "./paths";
import { fail, isNumber, isRecord, isString, type Json } from "./util";

export type RepoSpec = { name: string; url: string; defaultBranch?: string };

export const REPO_NAME_RE = /^[A-Za-z0-9_-]+$/;

const HEADER = `# overbridge repo registry. Add with \`overbridge repo add <name> <url>\`.
#
# [repos.example]
# url = "git@github.com:you/example.git"
# default_branch = "main"   # optional, defaults to the remote HEAD
#
# [sidebar]
# width = 60                # columns of the tab sidebar, 12 to 200
# motion = "while-active"   # "while-active" animates the busy glyph, "off" keeps it still
# layout = "auto"           # auto (compact when narrow), compact or wide
#
# [keys]
# leader = "ctrl-space"     # chord that presses a top panel button while Claude has focus: ctrl- or alt-, then space or a letter
`;

export function initReposFile() {
  if (!existsSync(reposFile())) writeFileSync(reposFile(), HEADER);
}

export function loadRepos(): Record<string, RepoSpec> {
  if (!existsSync(reposFile())) return {};

  const data = Bun.TOML.parse(readFileSync(reposFile(), "utf8"));
  const repos = isRecord(data) && isRecord(data.repos) ? data.repos : {};

  const specs = Object.entries(repos).map(([name, r]): [string, RepoSpec] => {
    if (!isRecord(r) || !isString(r.url) || !r.url) fail(`repos.toml: repos.${name} has no url`);

    return [name, { name, url: r.url, defaultBranch: isString(r.default_branch) ? r.default_branch : undefined }];
  });

  return Object.fromEntries(specs);
}

export const SIDEBAR_WIDTH = 60;
export const SIDEBAR_WIDTH_RANGE = { min: 12, max: 200 } as const;

/** Columns of the tab sidebar: `[sidebar] width` in repos.toml, else the default. */
export function sidebarWidth(): number {
  const width = readSidebarSection().width;

  if (width === undefined) return SIDEBAR_WIDTH;
  const { min, max } = SIDEBAR_WIDTH_RANGE;

  if (!isNumber(width) || !Number.isInteger(width) || width < min || width > max) {
    fail(`repos.toml: sidebar.width must be an integer from ${min} to ${max}`);
  }

  return width;
}

export function getRepo(name: string): RepoSpec {
  return loadRepos()[name] ?? fail(`unknown repo '${name}'; register it with \`overbridge repo add ${name} <url>\``);
}

export function appendRepo(spec: RepoSpec) {
  initReposFile();
  // JSON string literals are valid TOML basic strings.
  let block = `\n[repos.${spec.name}]\nurl = ${JSON.stringify(spec.url)}\n`;

  if (spec.defaultBranch) block += `default_branch = ${JSON.stringify(spec.defaultBranch)}\n`;
  appendFileSync(reposFile(), block);
}

/** `[keys] leader` in repos.toml: the chord that presses a top panel button from any pane (`ctrl-space` by default). */
export function leaderKey(): Leader {
  const data = existsSync(reposFile()) ? Bun.TOML.parse(readFileSync(reposFile(), "utf8")) : {};
  const keys = isRecord(data) && isRecord(data.keys) ? data.keys : {};
  const text = keys.leader;

  if (text === undefined) return parseLeader(DEFAULT_LEADER)!;

  return (isString(text) ? parseLeader(text) : undefined) ?? fail('repos.toml: keys.leader must be "ctrl-" or "alt-" and then "space" or a letter, such as "ctrl-space"');
}

/** `[sidebar] motion` in repos.toml: `off` keeps every glyph still, `while-active` animates a card only while its agent works. */
export const Motion = { Off: "off", WhileActive: "while-active" } as const;

export type Motion = (typeof Motion)[keyof typeof Motion];

type SidebarSection = { width?: Json; motion?: Json; layout?: Json };

/** The `[sidebar]` table of repos.toml; empty when the file or table is missing. */
function readSidebarSection(): SidebarSection {
  if (!existsSync(reposFile())) return {};
  const data = Bun.TOML.parse(readFileSync(reposFile(), "utf8"));
  const sidebar = isRecord(data) ? data.sidebar : undefined;

  return isRecord(sidebar) ? sidebar : {};
}

/** Whether the tab sidebar animates: `[sidebar] motion` in repos.toml, else `while-active`. Read once when the pane starts. */
export function sidebarMotion(): Motion {
  const motion = readSidebarSection().motion;

  if (motion === undefined) return Motion.WhileActive;
  const modes = Object.values(Motion);

  return modes.find((m) => m === motion) ?? fail(`repos.toml: sidebar.motion must be one of ${modes.map((m) => `"${m}"`).join(", ")}`);
}

export const SIDEBAR_LAYOUTS = ["auto", "compact", "wide"] as const;

export type SidebarLayout = (typeof SIDEBAR_LAYOUTS)[number];

/** `[sidebar] layout` in repos.toml: `auto` (the default) picks compact for a narrow pane, the others force one. */
export function sidebarLayout(): SidebarLayout {
  const layout = readSidebarSection().layout;

  if (layout === undefined) return "auto";
  const known = SIDEBAR_LAYOUTS.find((l) => l === layout);

  return known ?? fail(`repos.toml: sidebar.layout must be one of ${SIDEBAR_LAYOUTS.join(", ")}`);
}
