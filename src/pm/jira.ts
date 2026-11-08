import type { ProjectManagement } from "../project-config";
import { fail, run } from "../util";
import type { Runner } from "./github";
import { type Provider, type ProviderFactory, slug, type WorkItem } from "./provider";

const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Jira through `jira-cli`. `project` is the project key; a bare number means
 * `<KEY>-<n>`. `url` (the site's base URL) is needed only for `link`.
 */
export function jiraProvider(config: ProjectManagement, cwd: string, runner: Runner = run): Provider {
  const key = config.project.toUpperCase();
  if (!KEY_RE.test(key)) fail(`project-management.project '${config.project}': for jira expected a project key like ENG`);

  const jira = (args: string[]) => runner(["jira", ...args], { cwd });
  /** `123` and `eng-123` both become `ENG-123`. */
  const normalize = (id: string) => (/^\d+$/.test(id) ? `${key}-${id}` : id.toUpperCase());
  const base = config.url?.replace(/\/+$/, "");

  const items = (json: string): { key: string; summary: string }[] => {
    const rows = JSON.parse(json || "[]") as { key: string; fields?: { summary?: string } }[];
    return rows.map((row) => ({ key: row.key, summary: row.fields?.summary ?? "" }));
  };

  return {
    name: "jira",

    idFromBranch(branch) {
      // only this project's key: other keys in a branch name belong to other projects
      const m = new RegExp(`(?:^|[^A-Za-z0-9])(${escapeRegex(key)}-\\d+)(?![0-9])`, "i").exec(branch);
      return m?.[1]?.toUpperCase();
    },

    link(id) {
      if (!base) fail("jira: set project-management.url in overbridge.yml (e.g. https://example.atlassian.net) to build ticket links");
      return `${base}/browse/${normalize(id)}`;
    },

    title(id) {
      const r = jira(["issue", "view", normalize(id), "--raw"]);
      if (!r.ok) return undefined;
      try {
        return (JSON.parse(r.stdout) as { fields?: { summary?: string } }).fields?.summary || undefined;
      } catch {
        return undefined;
      }
    },

    assigned() {
      const jql = `project = ${key} AND assignee = currentUser() AND statusCategory != Done AND issuetype != Epic`;
      const r = jira(["issue", "list", "--jql", jql, "--raw"]);
      if (!r.ok) fail(`jira: listing assigned tickets failed: ${r.stderr || r.stdout}`);
      return items(r.stdout).map((i): WorkItem => ({ id: i.key, title: i.summary, url: base ? `${base}/browse/${i.key}` : "" }));
    },

    branchName: (item) => `feat/${normalize(item.id)}-${slug(item.title)}`,
  };
}

export const jiraFactory: ProviderFactory = (config, cwd) => jiraProvider(config, cwd);
