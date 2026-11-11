import { run, type RunResult } from "../util";
import { keyOf, statusFromColumn, type WorkRow, type WorkStatus } from "./worklist";

type Runner = (cmd: string[]) => RunResult;

/**
 * One request gives labels, parent, blockers and update time for up to 100 open issues assigned to a login,
 * so a refresh is one call per 100 issues rather than one per issue. `$after` pages past the first 100.
 */
export const BOARD_QUERY = `query($owner:String!,$name:String!,$login:String!,$after:String){repository(owner:$owner,name:$name){issues(first:100,after:$after,states:OPEN,filterBy:{assignee:$login},orderBy:{field:UPDATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor} nodes{number title url updatedAt projectItems(first:10){nodes{fieldValueByName(name:\"Status\"){...on ProjectV2ItemFieldSingleSelectValue{name}}}} labels(first:20){nodes{name}} parent{number} blockedBy(first:20){nodes{number state}}}}}}`;

interface Node {
  number: number;
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
export function rowsFromGraphql(reply: string, repo: string, columns: Record<string, WorkStatus> = {}): WorkRow[] {
  const nodes = (JSON.parse(reply) as Reply).data?.repository?.issues?.nodes ?? [];
  return nodes.map((n): WorkRow => {
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
export function githubRows(slug: string, repo: string, runner: Runner = run, columns: Record<string, WorkStatus> = {}): WorkRow[] {
  const [owner, name] = slug.split("/") as [string, string];
  const who = runner(["gh", "api", "user", "-q", ".login"]);
  if (!who.ok || !who.stdout.trim()) throw new Error(`github: cannot tell who is signed in: ${who.stderr || "gh printed nothing"}`);
  const rows: WorkRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = runner(["gh", "api", "graphql", "-f", `query=${BOARD_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `login=${who.stdout.trim()}`, ...(after ? ["-F", `after=${after}`] : [])]);
    if (!r.ok) throw new Error(`github: reading ${slug} failed: ${r.stderr || r.stdout}`);
    rows.push(...rowsFromGraphql(r.stdout, repo, columns));
    after = nextCursor(r.stdout);
    if (!after) return rows;
  }
  throw new Error(`github: ${slug} has more than ${MAX_PAGES * 100} open issues, stopping`);
}

/** `owner/name` from a GitHub remote URL (ssh or https), else undefined. */
export function slugFromUrl(url: string): string | undefined {
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1];
}
