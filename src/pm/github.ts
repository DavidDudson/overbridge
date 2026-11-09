import type { ProjectManagement } from "../project-config";
import { fail, run, type RunResult } from "../util";
import { namer, type Provider, type ProviderFactory, type WorkItem } from "./provider";

export type Runner = (cmd: string[], opts?: { cwd?: string }) => RunResult;

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const NUMBER_RE = /^\d+$/;

/**
 * GitHub issues through the `gh` CLI, so there is no token to store.
 * `project` is `owner/repo`, or a Projects v2 number: then issues come from the
 * repo checked out in `cwd`, narrowed to that project.
 */
export function githubProvider(config: ProjectManagement, cwd: string, runner: Runner = run): Provider {
  const gh = (args: string[]) => runner(["gh", ...args], { cwd });

  let resolved: string | undefined;
  /** `owner/repo`, looked up from `cwd` the first time a project number needs it. */
  const repo = (): string => {
    if (resolved) return resolved;
    if (REPO_RE.test(config.project)) return (resolved = config.project);
    const r = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
    if (!r.ok || !r.stdout) fail(`github: cannot tell which repo '${cwd}' belongs to: ${r.stderr || "gh printed nothing"}`);
    return (resolved = r.stdout);
  };

  if (!REPO_RE.test(config.project) && !NUMBER_RE.test(config.project)) {
    fail(`project-management.project '${config.project}': for github expected 'owner/repo' or a project number`);
  }

  const projectFilter = () => (NUMBER_RE.test(config.project) ? ` project:${repo().split("/")[0]}/${config.project}` : "");

  // idFromBranch finds the number at the start or after `/` or `#`, followed by `-` or the end
  if (config.branch && !/(?:^|[/#])\{(?:id|number)\}(?:-|$)/.test(config.branch)) {
    fail(`project-management.branch '${config.branch}': for github, {number} must start the name or follow '/' or '#', and be followed by '-' or the end`);
  }
  const names = namer(config, { branch: "{number}-{slug}", workspace: "gh-{repo}-{number}" }, (id) => id.replace(/^#/, ""), (id) => provider.itemTypes(id));

  const provider: Provider = {
    name: "github",

    idFromBranch(branch) {
      // `123-title`, `feat/123-title`, `fix/#123`, `#123`
      return /(?:^|[/#])(\d{1,7})(?:-|$)/.exec(branch)?.[1];
    },

    link: (id) => `https://github.com/${repo()}/issues/${id.replace(/^#/, "")}`,

    title(id) {
      const r = gh(["issue", "view", id.replace(/^#/, ""), "-R", repo(), "--json", "title", "-q", ".title"]);
      return r.ok && r.stdout ? r.stdout : undefined;
    },

    assigned() {
      const r = gh([
        "issue", "list", "-R", repo(), "--state", "open", "--limit", "100",
        "--search", `assignee:@me${projectFilter()}`,
        "--json", "number,title,url",
      ]);
      if (!r.ok) fail(`github: listing assigned issues failed: ${r.stderr || r.stdout}`);
      const rows = JSON.parse(r.stdout || "[]") as { number: number; title: string; url: string }[];
      return rows.map((i): WorkItem => ({ id: String(i.number), title: i.title, url: i.url }));
    },

    itemTypes(id) {
      const r = gh(["issue", "view", id.replace(/^#/, ""), "-R", repo(), "--json", "labels", "-q", ".labels[].name"]);
      return r.ok ? r.stdout.split("\n").filter(Boolean) : [];
    },

    ...names,

    createItem(item) {
      const args = ["issue", "create", "-R", repo(), "--title", item.title, "--body", item.body];
      for (const label of item.labels ?? []) args.push("--label", label);
      const created = gh(args);
      if (!created.ok) fail(`github: creating the issue failed: ${created.stderr || created.stdout}`);
      const url = created.stdout.trim().split("\n").pop()!;
      const id = /\/issues\/(\d+)$/.exec(url)?.[1];
      if (!id) fail(`github: gh created an issue but printed no issue URL: ${created.stdout}`);
      if (item.parent) {
        const parent = item.parent.replace(/^#/, "");
        // sub-issue links take the issue's database id, not its number
        const dbId = gh(["api", `repos/${repo()}/issues/${id}`, "-q", ".id"]);
        const link = dbId.ok
          ? gh(["api", "-X", "POST", `repos/${repo()}/issues/${parent}/sub_issues`, "-F", `sub_issue_id=${dbId.stdout}`])
          : dbId;
        if (!link.ok) fail(`github: created ${url} but could not attach it to #${parent}: ${link.stderr || link.stdout}`);
      }
      return { id, title: item.title, url };
    },

    updateItemBody(id, body) {
      const r = gh(["issue", "edit", id.replace(/^#/, ""), "-R", repo(), "--body", body]);
      if (!r.ok) fail(`github: updating #${id.replace(/^#/, "")} failed: ${r.stderr || r.stdout}`);
    },
  };
  return provider;
}

export const githubFactory: ProviderFactory = (config, cwd) => githubProvider(config, cwd);
