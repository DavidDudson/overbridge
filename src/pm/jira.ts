import { isJsonObject, isJsonString, type JsonValue } from "../json";
import type { ProjectManagement } from "../project-config";
import { fail, run } from "../util";
import type { Runner } from "./github";
import { type ItemNode, ItemStatus, namer, type Provider, type ProviderFactory, type WorkItem } from "./provider";

const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

/** The string at `path` below a parsed JSON value, or undefined when any step is missing or the end is not a string. */
const textAt = (root: JsonValue | undefined, path: string[]): string | undefined => {
  let node = root;

  for (const key of path) {
    if (!isJsonObject(node)) return undefined;
    node = node[key];
  }

  return isJsonString(node) ? node : undefined;
};

/** How many levels `lineage` climbs at most: Initiative, Epic, Task and Subtask, plus one spare level. */
const MAX_LINEAGE = 5;

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
    const rows: unknown = JSON.parse(json || "[]");

    return (Array.isArray(rows) ? rows : []).flatMap((row) => {
      const rowKey = textAt(isJsonObject(row) ? row : undefined, ["key"]);

      return rowKey === undefined ? [] : [{ key: rowKey, summary: textAt(isJsonObject(row) ? row : undefined, ["fields", "summary"]) ?? "" }];
    });
  };

  /** The fields of a ticket as `jira issue view --raw` prints it that the provider reads. */
  type Raw = { summary?: string; issueType?: string; statusCategory?: string; status?: string; parent?: string };

  /** The ticket, or undefined when it can't be read. */
  const view = (id: string): Raw | undefined => {
    const r = jira(["issue", "view", normalize(id), "--raw"]);

    if (!r.ok) return undefined;

    try {
      const parsed: unknown = JSON.parse(r.stdout);
      const root = isJsonObject(parsed) ? parsed : undefined;
      const raw: Raw = {};
      const summary = textAt(root, ["fields", "summary"]);
      const issueType = textAt(root, ["fields", "issuetype", "name"]);
      const statusCategory = textAt(root, ["fields", "status", "statusCategory", "key"]);
      const status = textAt(root, ["fields", "status", "name"]);
      const parent = textAt(root, ["fields", "parent", "key"]);

      if (summary !== undefined) raw.summary = summary;

      if (issueType !== undefined) raw.issueType = issueType;

      if (statusCategory !== undefined) raw.statusCategory = statusCategory;

      if (status !== undefined) {
        raw.status = status;
      }

      if (parent !== undefined) {
        raw.parent = parent;
      }

      return raw;
    } catch {
      return undefined;
    }
  };

  /** `key` and its parents, top first; stops at a ticket it can't read, a loop or `MAX_LINEAGE` levels. */
  const climb = (key: string, seen: readonly string[]): ItemNode[] => {
    if (seen.length >= MAX_LINEAGE || seen.includes(key)) {
      return [];
    }

    const raw = view(key);

    if (!raw) {
      return [];
    }

    const node: ItemNode = { id: key, title: raw.summary ?? "", status: raw.status ?? "", url: base ? `${base}/browse/${key}` : "" };

    return [...(raw.parent ? climb(raw.parent, [...seen, key]) : []), node];
  };

  const names = namer(config, { branch: "feat/{id}-{slug}", workspace: "{id}" }, normalize, (id) => provider.itemTypes(id));

  const provider: Provider = {
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

    title: (id) => view(id)?.summary || undefined,

    itemTypes(id) {
      const type = view(id)?.issueType;

      return type ? [type] : [];
    },

    status(id) {
      const category = view(id)?.statusCategory;

      if (!category) {
        return undefined;
      }

      return category === "done" ? ItemStatus.Done : ItemStatus.Open;
    },

    lineage: (id) => climb(normalize(id), []),

    assigned() {
      const jql = `project = ${key} AND assignee = currentUser() AND statusCategory != Done AND issuetype != Epic`;
      const r = jira(["issue", "list", "--jql", jql, "--raw"]);

      if (!r.ok) fail(`jira: listing assigned tickets failed: ${r.stderr || r.stdout}`);

      return items(r.stdout).map((i): WorkItem => ({ id: i.key, title: i.summary, url: base ? `${base}/browse/${i.key}` : "" }));
    },

    ...names,

    createItem(item) {
      const args = ["issue", "create", "-p", key, "-t", config.issueType ?? "Task", "-s", item.title, "-b", item.body, "--no-input"];

      for (const label of item.labels ?? []) args.push("-l", label);

      if (item.parent) args.push("-P", normalize(item.parent));
      const r = jira(args);

      if (!r.ok) fail(`jira: creating the ticket failed: ${r.stderr || r.stdout}`);
      // jira-cli prints the new ticket's browse URL on the last line
      const id = /\b([A-Z][A-Z0-9_]*-\d+)\s*$/.exec(r.stdout)?.[1];

      if (!id) fail(`jira: jira-cli created a ticket but printed no key: ${r.stdout}`);

      return { id, title: item.title, url: base ? `${base}/browse/${id}` : "" };
    },

    updateItemBody(id, body) {
      const r = jira(["issue", "edit", normalize(id), "-b", body, "--no-input"]);

      if (!r.ok) fail(`jira: updating ${normalize(id)} failed: ${r.stderr || r.stdout}`);
    },
  };

  return provider;
}

export const jiraFactory: ProviderFactory = (config, cwd) => jiraProvider(config, cwd);
