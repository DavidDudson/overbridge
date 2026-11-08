import type { ProjectManagement } from "../project-config";
import { type RunResult, fail, run } from "../util";
import { type NewItem, type Provider, type ProviderFactory, type WorkItem, slug } from "./provider";

/** Runs `gh` with `args` in `cwd`. Injectable so tests can stub the CLI. */
export type GhRunner = (args: string[], cwd: string) => RunResult;

const defaultGh: GhRunner = (args, cwd) => run(["gh", ...args], { cwd });

export const GITHUB_REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/** `owner/repo`, or a Projects v2 number. */
export const isGithubProject = (project: string) => GITHUB_REPO_RE.test(project) || /^\d+$/.test(project);

/** The item id a branch names: `123-short-title`, `feat/123-thing`, `#123`. */
export function idFromBranch(branch: string): string | undefined {
  return /(?:^|\/)#?(\d+)(?:-|$)/.exec(branch)?.[1];
}

/**
 * The GitHub provider, driven by the `gh` CLI so no token is stored. `project` is `owner/repo`; with a
 * Projects v2 number the issues are the ones of the repo checked out in `cwd`.
 */
export function createGithubProvider(config: ProjectManagement, cwd: string, gh: GhRunner = defaultGh): Provider {
  if (!isGithubProject(config.project)) {
    fail(`project-management.project '${config.project}': expected owner/repo or a project number for github`);
  }

  let repo = GITHUB_REPO_RE.test(config.project) ? config.project : undefined;
  const repoName = (): string => {
    if (repo) return repo;
    const r = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd);
    if (!r.ok || !r.stdout) fail(`could not resolve the GitHub repo for project ${config.project}: ${r.stderr || "empty answer"}`);
    return (repo = r.stdout);
  };

  const must = (args: string[]): string => {
    const r = gh(args, cwd);
    if (!r.ok) fail(`\`gh ${args.join(" ")}\` failed:\n${r.stderr || r.stdout}`);
    return r.stdout;
  };

  const base = (config.url ?? "https://github.com").replace(/\/+$/, "");

  return {
    name: "github",
    idFromBranch,
    link: (id) => `${base}/${repoName()}/issues/${id.replace(/^#/, "")}`,

    title(id) {
      const r = gh(["issue", "view", id.replace(/^#/, ""), "-R", repoName(), "--json", "title", "--jq", ".title"], cwd);
      return r.ok && r.stdout ? r.stdout : undefined;
    },

    assigned(): WorkItem[] {
      const r = gh(
        ["issue", "list", "-R", repoName(), "--assignee", "@me", "--state", "open", "--limit", "100", "--json", "number,title,url"],
        cwd,
      );
      if (!r.ok) return [];
      try {
        return (JSON.parse(r.stdout) as { number: number; title: string; url: string }[]).map((i) => ({
          id: String(i.number),
          title: i.title,
          url: i.url,
        }));
      } catch {
        return [];
      }
    },

    branchName: (item) => `${item.id.replace(/^#/, "")}-${slug(item.title)}`,

    createItem(item: NewItem): WorkItem {
      const args = ["issue", "create", "-R", repoName(), "--title", item.title, "--body", item.body];
      for (const label of item.labels ?? []) args.push("--label", label);
      const url = must(args).split("\n").pop()!.trim();
      const id = /\/issues\/(\d+)$/.exec(url)?.[1];
      if (!id) fail(`gh created an issue but printed no issue URL: ${url}`);
      if (item.parent) {
        // Sub-issue links take the issue's database id, not its number.
        const dbId = must(["api", `repos/${repoName()}/issues/${id}`, "--jq", ".id"]);
        const parent = item.parent.replace(/^#/, "");
        const link = gh(["api", "-X", "POST", `repos/${repoName()}/issues/${parent}/sub_issues`, "-F", `sub_issue_id=${dbId}`], cwd);
        if (!link.ok) fail(`created ${url} but could not attach it to #${parent}:\n${link.stderr || link.stdout}`);
      }
      return { id, title: item.title, url };
    },

    updateItemBody(id, body) {
      must(["issue", "edit", id.replace(/^#/, ""), "-R", repoName(), "--body", body]);
    },
  };
}

export const githubFactory: ProviderFactory = (config, cwd) => createGithubProvider(config, cwd);
