import { cachedValue, USER_TTL_MS } from "../value-cache";
import { run, type RunResult } from "../util";
import { keyOf, statusFromColumn, type WorkRow, type WorkStatus } from "./worklist";

type Runner = (cmd: string[]) => RunResult;

export const BOARD_FIELDS = `pageInfo{hasNextPage endCursor} nodes{number title url updatedAt assignees(first:1){totalCount} projectItems(first:10){nodes{fieldValueByName(name:\"Status\"){...on ProjectV2ItemFieldSingleSelectValue{name}}}} labels(first:20){nodes{name}} parent{number} blockedBy(first:20){nodes{number state}}}`;

/** Whose issues the list shows: those assigned to you, those in the project with nobody on them, or both. */
export const WORKLIST_SCOPES = ["assigned", "unassigned", "all"] as const;
export type WorklistScope = (typeof WORKLIST_SCOPES)[number];

/**
 * The query for one scope. Only `assigned` filters on a login: GraphQL rejects a declared variable that is
 * never used, so the others leave `$login` out.
 */
export const boardQuery = (scope: WorklistScope = "assigned"): string =>
  `query($owner:String!,$name:String!${scope === "assigned" ? ",$login:String!" : ""},$after:String){repository(owner:$owner,name:$name){issues(first:100,after:$after,states:OPEN,${scope === "assigned" ? "filterBy:{assignee:$login}," : ""}orderBy:{field:UPDATED_AT,direction:DESC}){${BOARD_FIELDS}}}}`;

/**
 * One request gives labels, parent, blockers and update time for up to 100 open issues assigned to a login,
 * so a refresh is one call per 100 issues rather than one per issue. `$after` pages past the first 100.
 */
export const BOARD_QUERY = boardQuery("assigned");

interface Node {
  number: number;
  assignees?: { totalCount: number };
  title: string;
  url: string;
  updatedAt: string;
  labels: { nodes: { name: string }[] };
  projectItems?: { nodes: ({ fieldValueByName: { name?: string } | null } | null)[] };
  parent: { number: number } | null;
  blockedBy: { nodes: { number: number; state: string }[] };
}

/** `blocked` and `in progress` style labels set the status; anything else is todo. */
function statusFromLabels(labels: string[]): WorkStatus {
  const found = labels.map((l) => statusFromColumn(l));
  return found.find((s) => s === "blocked") ?? found.find((s) => s === "in-progress") ?? "todo";
}

/** Pages read per repo at most, so a bad cursor can never loop forever. */
export const MAX_PAGES = 50;

type Reply = { data?: { repository?: { issues?: { nodes?: Node[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } } } };

/** The cursor of the next page of a reply, or undefined on the last page. */
export function nextCursor(reply: string): string | undefined {
  const info = (JSON.parse(reply) as Reply).data?.repository?.issues?.pageInfo;
  return info?.hasNextPage && info.endCursor ? info.endCursor : undefined;
}

/** `unassigned` keeps only issues nobody holds that sit on a project board, so stray issues do not flood the list. */
function inScope(n: Node, scope: WorklistScope): boolean {
  if (scope !== "unassigned") return true;
  return (n.assignees?.totalCount ?? 0) === 0 && (n.projectItems?.nodes.some((i) => i !== null) ?? false);
}

/** The `Status` of the first project the issue is on that has one set. */
function boardColumn(n: Node): string | undefined {
  return n.projectItems?.nodes.map((i) => i?.fieldValueByName?.name).find((name) => !!name);
}

/**
 * The board column decides the status when it says anything but todo; a todo column (or no column) still
 * lets a `blocked` or `in progress` label speak, so a label-only workflow keeps working.
 */
function statusOf(n: Node, labels: string[], columns: Record<string, WorkStatus>): WorkStatus {
  const column = boardColumn(n);
  const fromColumn = column ? statusFromColumn(column, columns) : "todo";
  return fromColumn !== "todo" ? fromColumn : statusFromLabels(labels);
}

/**
 * Rows for one repo from the GraphQL reply. Only open blockers are kept: the list holds open issues
 * only, so a closed blocker would otherwise read as unfinished.
 */
export function rowsFromGraphql(reply: string, repo: string, columns: Record<string, WorkStatus> = {}, scope: WorklistScope = "assigned"): WorkRow[] {
  const nodes = (JSON.parse(reply) as Reply).data?.repository?.issues?.nodes ?? [];
  return nodes.filter((n) => inScope(n, scope)).map((n): WorkRow => {
    const labels = n.labels.nodes.map((l) => l.name);
    return {
      repo,
      id: String(n.number),
      title: n.title,
      url: n.url,
      status: statusOf(n, labels, columns),
      labels,
      blockedBy: n.blockedBy.nodes.filter((b) => b.state === "OPEN").map((b) => keyOf({ repo, id: String(b.number) })),
      ...(n.parent ? { parent: keyOf({ repo, id: String(n.parent.number) }) } : {}),
      updatedAt: n.updatedAt,
    };
  });
}

/** Open issues assigned to the signed-in user in `owner/name`, as work rows labelled with `repo`. */
export function githubRows(slug: string, repo: string, runner: Runner = run, columns: Record<string, WorkStatus> = {}, scope: WorklistScope = "assigned"): WorkRow[] {
  const [owner, name] = slug.split("/") as [string, string];
  const login: string[] = [];
  if (scope === "assigned") {
    let failure = "";
    const read = () => {
      const r = runner(["gh", "api", "user", "-q", ".login"]);
      failure = r.stderr || "gh printed nothing";
      return r.ok && r.stdout.trim() ? r.stdout.trim() : undefined;
    };
    // who is signed in changes almost never: one read per hour for every worklist refresh. A caller that injects its own runner (a test) is not cached.
    const who = runner === run ? cachedValue("gh:user", USER_TTL_MS, read) : read();
    if (!who) throw new Error(`github: cannot tell who is signed in: ${failure}`);
    login.push("-F", `login=${who}`);
  }
  const rows: WorkRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = runner(["gh", "api", "graphql", "-f", `query=${boardQuery(scope)}`, "-F", `owner=${owner}`, "-F", `name=${name}`, ...login, ...(after ? ["-F", `after=${after}`] : [])]);
    if (!r.ok) throw new Error(`github: reading ${slug} failed: ${r.stderr || r.stdout}`);
    rows.push(...rowsFromGraphql(r.stdout, repo, columns, scope));
    after = nextCursor(r.stdout);
    if (!after) return rows;
  }
  throw new Error(`github: ${slug} has more than ${MAX_PAGES * 100} open issues, stopping`);
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
export function rowsFromProject(json: string, slug: string, repo: string, statuses?: string[], columns: Record<string, WorkStatus> = {}): WorkRow[] {
  const items = (JSON.parse(json) as { items?: ProjectItem[] }).items ?? [];
  const want = statuses?.map((s) => s.trim().toLowerCase());
  return items.flatMap((i): WorkRow[] => {
    const c = i.content;
    if (!c || c.type !== "Issue" || c.number === undefined || c.repository !== slug) return [];
    const status = statusFromColumn(i.status, columns);
    if (want ? !want.includes((i.status ?? "").trim().toLowerCase()) : status === "done") return [];
    const labels = i.labels ?? [];
    return [{ repo, id: String(c.number), title: c.title ?? i.title ?? "", url: c.url ?? "", status, labels: i.priority ? [...labels, i.priority] : labels, blockedBy: [], updatedAt: "" }];
  });
}

/** Items of a Projects v2 board that belong to `slug`, as work rows labelled with `repo`. Needs `gh auth refresh -s project`. */
export function projectRows(board: ProjectBoard, slug: string, repo: string, runner: Runner = run, columns: Record<string, WorkStatus> = {}): WorkRow[] {
  const r = runner(["gh", "project", "item-list", String(board.number), "--owner", board.owner, "--limit", "500", "--format", "json"]);
  if (!r.ok) throw new Error(`github: reading project ${board.owner}/${board.number} failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}. Check \`gh auth refresh -s project\``);
  return rowsFromProject(r.stdout, slug, repo, board.statuses, columns);
}

/** `owner/name` from a GitHub remote URL (ssh or https), else undefined. */
export function slugFromUrl(url: string): string | undefined {
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1];
}
