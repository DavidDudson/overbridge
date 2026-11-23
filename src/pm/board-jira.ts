import { run, type RunResult } from "../util";
import { cachedValue } from "../value-cache";
import { isJsonObject, isJsonString, type JsonValue } from "../json";
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

export interface RawIssue {
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

// SAFETY: `jira issue list --raw` prints a JSON array of issues; RawIssue marks every field except `key` optional, so absent fields are tolerated, but the array and `key` are trusted from the CLI.
const parseIssues = (reply: string): RawIssue[] => JSON.parse(reply.trim() || "[]") as RawIssue[];

const typeOf = (issue: RawIssue) => (issue.fields?.issueType ?? issue.fields?.issuetype)?.name;

const isEpic = (issue: RawIssue) => /^epic$/i.test(typeOf(issue) ?? "");

/** How many levels above a listed ticket `jiraRows` reads to find its epic: a subtask's task, then that task's epic. */
const EPIC_LOOKUPS = 2;

/** The epic above `issue`: its parent when that is an epic, else its parent's epic, found in `known`. */
export function epicOf(issue: RawIssue, known: ReadonlyMap<string, RawIssue>, depth = 0): RawIssue | undefined {
  const parentKey = issue.fields?.parent?.key;
  const parent = parentKey ? known.get(parentKey) : undefined;

  if (!parent || depth >= EPIC_LOOKUPS) {
    return undefined;
  }

  return isEpic(parent) ? parent : epicOf(parent, known, depth + 1);
}

/**
 * Rows from `jira issue list --raw`. One project can back several repos, so each ticket appears once,
 * labelled with the project key, and carries every repo it could be started in. `ancestors` holds tickets above the
 * listed ones (`jiraRows` reads them), so each row can name its epic.
 */
export function rowsFromJiraRaw(reply: string, project: string, repos: string[], site?: string, ancestors: readonly RawIssue[] = []): WorkRow[] {
  const issues = parseIssues(reply);
  const base = site?.replace(/\/+$/, "");
  const known = new Map([...issues, ...ancestors].map((i) => [i.key, i] as const));

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

    const epic = epicOf(i, known);

    if (epic) {
      row.epic = epic.key;

      if (epic.fields?.summary) {
        row.epicTitle = epic.fields.summary;
      }
    }

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
export function jiraRows(project: string, repos: string[], opts: { filter?: string; site?: string } = {}, runner: Runner = run, read: TicketReader = cachedTicket(viewTicket(runner))): WorkRow[] {
  const r = runner(["jira", "issue", "list", "--jql", worklistJql(project, opts.filter), "--raw"]);

  if (!r.ok) {
    throw new Error(`jira: reading ${project} failed: ${(r.stderr || r.stdout).trim()}. Check \`jira me\` works and project-management.worklist-jql is valid JQL`);
  }

  return rowsFromJiraRaw(r.stdout, project, repos, opts.site, ancestorsOf(parseIssues(r.stdout), read));
}

/** Reads one ticket by key; undefined when it can't be read. */
export type TicketReader = (key: string) => RawIssue | undefined;

/** How long a parent ticket's type, summary and parent stay cached: they change rarely, and the list refreshes every minute. */
export const PARENT_TTL_MS = 10 * 60_000;

/** One ticket from `jira issue view --raw` (or the cache), cut to what `epicOf` reads; undefined when it is not a ticket. */
export function parseTicket(text: string): RawIssue | undefined {
  try {
    const parsed: JsonValue = JSON.parse(text);

    if (!isJsonObject(parsed) || !isJsonString(parsed.key)) {
      return undefined;
    }

    const fields = isJsonObject(parsed.fields) ? parsed.fields : {};
    const nameOf = (v: JsonValue | undefined) => (isJsonObject(v) && isJsonString(v.name) ? v.name : "");
    const parent = isJsonObject(fields.parent) && isJsonString(fields.parent.key) ? { key: fields.parent.key } : null;

    return { key: parsed.key, fields: { summary: isJsonString(fields.summary) ? fields.summary : "", issuetype: { name: nameOf(fields.issuetype) || nameOf(fields.issueType) }, parent } };
  } catch {
    return undefined;
  }
}

/** Reads a ticket with `jira issue view --raw`, which has no project filter, so a parent in another project is found too. */
export const viewTicket =
  (runner: Runner = run): TicketReader =>
  (key) => {
    const r = runner(["jira", "issue", "view", key, "--raw"]);

    return r.ok ? parseTicket(r.stdout) : undefined;
  };

/** `read` with each ticket kept in `<meta>/values.json` for `PARENT_TTL_MS`; a failed read serves the last one. */
export const cachedTicket =
  (read: TicketReader): TicketReader =>
  (key) => {
    const stored = cachedValue(`jira:ticket:${key}`, PARENT_TTL_MS, () => {
      const issue = read(key);

      return issue ? JSON.stringify(issue) : undefined;
    });

    return stored ? parseTicket(stored) : undefined;
  };

/**
 * The tickets above `issues` up to their epics, one level at a time. `--raw` lists give a parent's key but not its type or
 * summary, so each parent is read on its own: one that can't be read costs only its own rows their epic.
 */
export function ancestorsOf(issues: readonly RawIssue[], read: TicketReader, known: ReadonlyMap<string, RawIssue> = new Map(issues.map((i) => [i.key, i] as const)), level = 0): RawIssue[] {
  const missing = [...new Set(issues.filter((i) => !isEpic(i)).flatMap((i) => (i.fields?.parent?.key ? [i.fields.parent.key] : [])))].filter((k) => !known.has(k));

  if (!missing.length || level >= EPIC_LOOKUPS) {
    return [];
  }

  const found = missing.flatMap((k) => read(k) ?? []);
  const next = new Map([...known, ...found.map((i) => [i.key, i] as const)]);

  return [...found, ...ancestorsOf(found, read, next, level + 1)];
}
