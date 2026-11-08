import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { reposFile } from "./paths";
import { fail } from "./util";

export type RepoSpec = { name: string; url: string; defaultBranch?: string };

export const REPO_NAME_RE = /^[A-Za-z0-9_-]+$/;

const HEADER = `# overbridge repo registry. Add with \`overbridge repo add <name> <url>\`.
#
# [repos.example]
# url = "git@github.com:you/example.git"
# default_branch = "main"   # optional, defaults to the remote HEAD
#
# [sidebar]
# width = 28                # columns of the tab sidebar, 12 to 80
`;

export function initReposFile() {
  if (!existsSync(reposFile())) writeFileSync(reposFile(), HEADER);
}

export function loadRepos(): Record<string, RepoSpec> {
  if (!existsSync(reposFile())) return {};
  const data = Bun.TOML.parse(readFileSync(reposFile(), "utf8")) as {
    repos?: Record<string, { url?: string; default_branch?: string }>;
  };
  const out: Record<string, RepoSpec> = {};
  for (const [name, r] of Object.entries(data.repos ?? {})) {
    if (!r.url) fail(`repos.toml: repos.${name} has no url`);
    out[name] = { name, url: r.url, defaultBranch: r.default_branch };
  }
  return out;
}

export const SIDEBAR_WIDTH = 28;
export const SIDEBAR_WIDTH_RANGE = { min: 12, max: 80 } as const;

/** Columns of the tab sidebar: `[sidebar] width` in repos.toml, else the default. */
export function sidebarWidth(): number {
  if (!existsSync(reposFile())) return SIDEBAR_WIDTH;
  const data = Bun.TOML.parse(readFileSync(reposFile(), "utf8")) as { sidebar?: { width?: unknown } };
  const width = data.sidebar?.width;
  if (width === undefined) return SIDEBAR_WIDTH;
  const { min, max } = SIDEBAR_WIDTH_RANGE;
  if (typeof width !== "number" || !Number.isInteger(width) || width < min || width > max) {
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
