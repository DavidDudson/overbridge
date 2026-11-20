import { run, type RunResult } from "../util";
import { statusFromColumn, type WorkRow } from "./worklist";

type Runner = (cmd: string[]) => RunResult;

/** Tickets in a sprint that is running now, or already started. Override with `project-management.worklist-jql`. */
export const DEFAULT_WORKLIST_JQL = `(sprint in openSprints() OR statusCategory = "In Progress")`;

/** Jira's priority names to the work list's p0..p3. Unknown names leave the priority unset. */
const PRIORITY = new Map([
  ["highest", 0],
  ["blocker", 0],
  ["critical", 0],
  ["high", 1],
  ["medium", 2],
  ["low", 3],
  ["lowest", 3],
  ["trivial", 3],
]);

export const priorityFromJira = (name: string | undefined): number | undefined => (name ? PRIORITY.get(name.trim().toLowerCase()) : undefined);

interface LinkedIssue {
  key: string;
  fields?: { status?: { name?: string }; resolution?: { name?: string } | null };
}

interface RawIssue {
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string };
    priority?: { name?: string } | null;
    /** `jira --raw` spells it `issueType`; Jira's REST API spells it `issuetype`. */
    issueType?: { name?: string } | null;
    issuetype?: { name?: string } | null;
    labels?: string[] | null;
    parent?: { key?: string } | null;
    updated?: string;
    issueLinks?: { type?: { name?: string; inward?: string }; inwardIssue?: LinkedIssue; outwardIssue?: LinkedIssue }[] | null;
  };
}

/** A linked ticket is finished when its column reads as done or it has a resolution. `jira --raw` gives no status category. */
const finished = (issue: LinkedIssue) => statusFromColumn(issue.fields?.status?.name) === "done" || !!issue.fields?.resolution?.name;

/**
 * Tickets that block `issue` and are still open. A "Blocks" link on this ticket with an `inwardIssue` reads
 * "this ticket is blocked by inwardIssue"; an `outwardIssue` is a ticket this one blocks.
 */
function openBlockers(issue: RawIssue): string[] {
  return (issue.fields?.issueLinks ?? [])
    .filter((l) => (l.type?.name === "Blocks" || l.type?.inward === "is blocked by") && l.inwardIssue && !finished(l.inwardIssue))
    .map((l) => l.inwardIssue!.key);
}

/**
 * Rows from `jira issue list --raw`. One project can back several repos, so each ticket appears once,
 * labelled with the project key, and carries every repo it could be started in.
 */
export function rowsFromJiraRaw(reply: string, project: string, repos: string[], site?: string): WorkRow[] {
  // SAFETY: `jira issue list --raw` prints a JSON array of issues; RawIssue marks every field except `key` optional, so absent fields are tolerated, but the array and `key` are trusted from the CLI.
  const issues = JSON.parse(reply.trim() || "[]") as RawIssue[];
  const base = site?.replace(/\/+$/, "");

  return issues.map((i): WorkRow => {
    const f = i.fields ?? {};
    const priority = priorityFromJira(f.priority?.name ?? undefined);
    const type = (f.issueType ?? f.issuetype)?.name;

    const row: WorkRow = {
      repo: project,
      repos,
      id: i.key,
      title: f.summary ?? "",
      url: base ? `${base}/browse/${i.key}` : "",
      status: statusFromColumn(f.status?.name),
      labels: f.labels ?? [],
      blockedBy: openBlockers(i),
      updatedAt: f.updated ?? "",
    };

    if (f.parent?.key) row.parent = f.parent.key;

    if (priority !== undefined) row.priority = priority;

    if (type) {
      row.type = type;
    }

    return row;
  });
}

/** The JQL the work list runs: this project's open tickets assigned to the signed-in user, narrowed by `filter`. */
export const worklistJql = (project: string, filter = DEFAULT_WORKLIST_JQL) =>
  `project = ${project} AND assignee = currentUser() AND statusCategory != Done AND issuetype != Epic${filter.trim() ? ` AND (${filter.trim()})` : ""}`;

/** Open tickets assigned to the signed-in user in Jira project `project`, one row per ticket. */
export function jiraRows(project: string, repos: string[], opts: { filter?: string; site?: string } = {}, runner: Runner = run): WorkRow[] {
  const r = runner(["jira", "issue", "list", "--jql", worklistJql(project, opts.filter), "--raw"]);

  if (!r.ok) {
    throw new Error(`jira: reading ${project} failed: ${(r.stderr || r.stdout).trim()}. Check \`jira me\` works and project-management.worklist-jql is valid JQL`);
  }

  return rowsFromJiraRaw(r.stdout, project, repos, opts.site);
}
