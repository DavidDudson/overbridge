import { run, type RunResult } from "../util";
import { keyOf, statusFromColumn, type WorkRow, type WorkStatus } from "./worklist";

type Runner = (cmd: string[]) => RunResult;

/**
 * One request gives labels, parent, blockers and update time for up to 100 open issues assigned to a login,
 * so a refresh is one call per repo rather than one per issue.
 */
export const BOARD_QUERY = `query($owner:String!,$name:String!,$login:String!){repository(owner:$owner,name:$name){issues(first:100,states:OPEN,filterBy:{assignee:$login},orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title url updatedAt labels(first:20){nodes{name}} parent{number} blockedBy(first:20){nodes{number state}}}}}}`;

interface Node {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  labels: { nodes: { name: string }[] };
  parent: { number: number } | null;
  blockedBy: { nodes: { number: number; state: string }[] };
}

/** `blocked` and `in progress` style labels set the status; anything else is todo. */
function statusFromLabels(labels: string[]): WorkStatus {
  const found = labels.map((l) => statusFromColumn(l));
  return found.find((s) => s === "blocked") ?? found.find((s) => s === "in-progress") ?? "todo";
}

/**
 * Rows for one repo from the GraphQL reply. Only open blockers are kept: the list holds open issues
 * only, so a closed blocker would otherwise read as unfinished.
 */
export function rowsFromGraphql(reply: string, repo: string): WorkRow[] {
  const nodes = (JSON.parse(reply) as { data?: { repository?: { issues?: { nodes?: Node[] } } } }).data?.repository?.issues?.nodes ?? [];
  return nodes.map((n): WorkRow => {
    const labels = n.labels.nodes.map((l) => l.name);
    return {
      repo,
      id: String(n.number),
      title: n.title,
      url: n.url,
      status: statusFromLabels(labels),
      labels,
      blockedBy: n.blockedBy.nodes.filter((b) => b.state === "OPEN").map((b) => keyOf({ repo, id: String(b.number) })),
      ...(n.parent ? { parent: keyOf({ repo, id: String(n.parent.number) }) } : {}),
      updatedAt: n.updatedAt,
    };
  });
}

/** Open issues assigned to the signed-in user in `owner/name`, as work rows labelled with `repo`. */
export function githubRows(slug: string, repo: string, runner: Runner = run): WorkRow[] {
  const [owner, name] = slug.split("/") as [string, string];
  const who = runner(["gh", "api", "user", "-q", ".login"]);
  if (!who.ok || !who.stdout.trim()) throw new Error(`github: cannot tell who is signed in: ${who.stderr || "gh printed nothing"}`);
  const r = runner(["gh", "api", "graphql", "-f", `query=${BOARD_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `login=${who.stdout.trim()}`]);
  if (!r.ok) throw new Error(`github: reading ${slug} failed: ${r.stderr || r.stdout}`);
  return rowsFromGraphql(r.stdout, repo);
}

export interface ProjectBoard {
  owner: string;
  number: number;
  /** Status values to keep, matched without case. Unset keeps all but Done. */
  statuses?: string[];
}

/** Reads `worklist-project`: `<owner>/<number>`, or a bare number for `defaultOwner`. */
export function parseProject(spec: string, defaultOwner: string | undefined, statuses?: string[]): ProjectBoard | undefined {
  const m = /^(?:([\w.-]+)\/)?(\d+)$/.exec(spec.trim());
  const owner = m?.[1] ?? defaultOwner;
  return m && owner ? { owner, number: Number(m[2]), ...(statuses ? { statuses } : {}) } : undefined;
}

interface ProjectItem {
  id?: string;
  title?: string;
  status?: string;
  labels?: string[];
  priority?: string;
  content?: { type?: string; number?: number; repository?: string; title?: string; url?: string };
}

/** Rows for `repo` (GitHub `slug`) from `gh project item-list --format json`. Items of other repos, drafts and pull requests are left out. */
export function rowsFromProject(json: string, slug: string, repo: string, statuses?: string[]): WorkRow[] {
  const items = (JSON.parse(json) as { items?: ProjectItem[] }).items ?? [];
  const want = statuses?.map((s) => s.trim().toLowerCase());
  return items.flatMap((i): WorkRow[] => {
    const c = i.content;
    if (!c || c.type !== "Issue" || c.number === undefined || c.repository !== slug) return [];
    const status = statusFromColumn(i.status);
    if (want ? !want.includes((i.status ?? "").trim().toLowerCase()) : status === "done") return [];
    const labels = i.labels ?? [];
    return [{ repo, id: String(c.number), title: c.title ?? i.title ?? "", url: c.url ?? "", status, labels: i.priority ? [...labels, i.priority] : labels, blockedBy: [], updatedAt: "" }];
  });
}

/** Items of a Projects v2 board that belong to `slug`, as work rows labelled with `repo`. Needs `gh auth refresh -s project`. */
export function projectRows(board: ProjectBoard, slug: string, repo: string, runner: Runner = run): WorkRow[] {
  const r = runner(["gh", "project", "item-list", String(board.number), "--owner", board.owner, "--limit", "500", "--format", "json"]);
  if (!r.ok) throw new Error(`github: reading project ${board.owner}/${board.number} failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}. Check \`gh auth refresh -s project\``);
  return rowsFromProject(r.stdout, slug, repo, board.statuses);
}

/** `owner/name` from a GitHub remote URL (ssh or https), else undefined. */
export function slugFromUrl(url: string): string | undefined {
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1];
}
