import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { committedConfig } from "./committed-config";
import { loadRepos } from "./config";
import { loadRootLayers } from "./project-config";
import { metaDir } from "./paths";
import { githubRows, parseProject, projectRows, slugFromUrl, type ProjectBoard, type WorklistScope } from "./pm/board-github";
import { jiraRows } from "./pm/board-jira";
import { keyOf, type WorkRow, type WorkStatus } from "./pm/worklist";
import type { ProjectManagement } from "./project-config";
import { errorMessage, isNumber, isRecord, isString, type Json } from "./util";

/**
 * The work list's data: what a refresh reads and writes, with no pane code. The server and its workers import this, so
 * it must not reach the terminal modules (`worklist-run.ts` holds those).
 */

/** The panel is a prototype (spike #108): one list, refreshed by a child process, never fetched while drawing. */
export const WORKLIST_REFRESH_MS = 60_000;

export interface WorklistCache {
  at: number;
  rows: WorkRow[];
  /** One line per repo or Jira project that could not be read. */
  notes: string[];
}

export const worklistPath = () => join(metaDir(), "worklist.json");

const WORK_STATUSES = ["todo", "in-progress", "blocked", "done"] as const satisfies readonly WorkStatus[];

const isStrings = (v: Json | undefined) => Array.isArray(v) && v.every(isString);

const optional = (v: Json | undefined, check: (v: Json) => boolean) => v === undefined || check(v);

/** A cached work row: every `WorkRow` field present has its type, so no reader of the cache can throw on it. */
export const isWorkRow = (v: Json): v is Json & WorkRow =>
  isRecord(v) &&
  isString(v.repo) &&
  isString(v.id) &&
  isString(v.title) &&
  isString(v.url) &&
  isString(v.updatedAt) &&
  WORK_STATUSES.some((s) => s === v.status) &&
  isStrings(v.blockedBy) &&
  isStrings(v.labels) &&
  optional(v.repos, isStrings) &&
  optional(v.parent, isString) &&
  optional(v.type, isString) &&
  optional(v.priority, isNumber);

/** The cached list; an empty one when the file is missing, unreadable or not a cache, so no reader has to check its shape. */
export function readWorklist(): WorklistCache {
  const empty: WorklistCache = { at: 0, rows: [], notes: [] };

  try {
    // SAFETY: JSON.parse returns plain JSON values, which is what `Json` describes
    const parsed = JSON.parse(readFileSync(worklistPath(), "utf8")) as Json;

    return isRecord(parsed) && Array.isArray(parsed.rows) && Array.isArray(parsed.notes)
      ? { at: isNumber(parsed.at) ? parsed.at : 0, rows: parsed.rows.filter(isWorkRow), notes: parsed.notes.filter(isString) }
      : empty;
  } catch {
    return empty;
  }
}

function writeWorklist(cache: WorklistCache) {
  mkdirSync(metaDir(), { recursive: true });
  const tmp = `${worklistPath()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n");
  renameSync(tmp, worklistPath());
}

/** One board read: a GitHub repo, or a Jira project shared by every repo that names it. */
export interface GithubSource {
  kind: "github";
  repo: string;
  slug: string;
  columns?: Record<string, WorkStatus>;
  scope?: WorklistScope;
  project?: ProjectBoard;
}

export interface JiraSource {
  kind: "jira";
  project: string;
  repos: string[];
  filter?: string;
  site?: string;
}

export type BoardSource = GithubSource | JiraSource;

/** The reads a refresh makes, and a note for each repo whose board could not be planned. */
export interface WorklistPlan {
  sources: BoardSource[];
  notes: string[];
}

export interface GithubReadOptions {
  columns?: Record<string, WorkStatus>;
  scope?: WorklistScope;
  project?: ProjectBoard;
}

export interface JiraReadOptions {
  filter?: string;
  site?: string;
}

export interface RepoBoard {
  repo: string;
  url: string;
  pm?: ProjectManagement;
  /** `board.columns`, when the repo sets any. */
  columns?: Record<string, WorkStatus>;
}

/**
 * The reads a refresh makes. Repos on the same Jira project and filter share one read, so a ticket is listed once
 * however many repos it could land in.
 */
export function boardSources(repos: readonly RepoBoard[]): WorklistPlan {
  const withPm = repos.filter((r): r is RepoBoard & { pm: ProjectManagement } => r.pm !== undefined);

  const github = withPm.flatMap((r) => (r.pm.name === "github" ? [{ r, slug: slugFromUrl(r.url) ?? (/^[\w.-]+\/[\w.-]+$/.test(r.pm.project) ? r.pm.project : undefined) }] : []));

  const jiraRepos = withPm.filter((r) => r.pm.name === "jira");
  const jiraGroups = Map.groupBy(jiraRepos, (r) => JSON.stringify([r.pm.project.toUpperCase(), r.pm.worklistJql ?? null, r.pm.url ?? null]));

  const jira = [...jiraGroups.values()].map((group): BoardSource => {
    const pm = group[0]!.pm;
    const source: JiraSource = { kind: "jira", project: pm.project.toUpperCase(), repos: group.map((r) => r.repo) };

    if (pm.worklistJql !== undefined) source.filter = pm.worklistJql;

    if (pm.url) source.site = pm.url;

    return source;
  });

  return {
    sources: [
      ...github.flatMap(({ r, slug }): BoardSource[] => {
        if (!slug) return [];
        const project = r.pm.worklistProject ? parseProject(r.pm.worklistProject, slug.split("/")[0], r.pm.worklistStatuses) : undefined;

        const source: GithubSource = { kind: "github", repo: r.repo, slug };

        if (r.columns && Object.keys(r.columns).length) source.columns = r.columns;

        if (r.pm.worklistScope) source.scope = r.pm.worklistScope;

        if (project) source.project = project;

        return [source];
      }),
      ...jira,
    ],
    notes: [
      ...github.flatMap(({ r, slug }) => (slug ? [] : [`${r.repo}: cannot tell the GitHub repo from ${r.url}`])),
      ...github.flatMap(({ r, slug }) => (slug && r.pm.worklistProject && !parseProject(r.pm.worklistProject, slug.split("/")[0]) ? [`${r.repo}: bad worklist-project ${r.pm.worklistProject}`] : [])),
    ],
  };
}

export interface BoardReaders {
  github: (slug: string, repo: string, opts?: GithubReadOptions) => WorkRow[];
  jira: (project: string, repos: string[], opts: JiraReadOptions) => WorkRow[];
}

const defaultReaders: BoardReaders = {
  github: (slug, repo, opts) => (opts?.project ? projectRows(opts.project, slug, repo, undefined, opts.columns) : githubRows(slug, repo, undefined, opts?.columns, opts?.scope)),
  jira: (project, repos, opts) => jiraRows(project, repos, opts),
};

const sourceName = (s: BoardSource) => (s.kind === "github" ? s.repo : s.project);

export interface SourceRead {
  rows: WorkRow[];
  notes: string[];
  failedRepos: string[];
}

function githubReadOptions(s: GithubSource): GithubReadOptions {
  const opts: GithubReadOptions = {};

  if (s.columns) opts.columns = s.columns;

  if (s.scope) opts.scope = s.scope;

  if (s.project) opts.project = s.project;

  return opts;
}

function jiraReadOptions(s: JiraSource): JiraReadOptions {
  const opts: JiraReadOptions = {};

  if (s.filter !== undefined) opts.filter = s.filter;

  if (s.site) opts.site = s.site;

  return opts;
}

/** Read one source. A source that fails adds a note and no rows. */
export function readSource(s: BoardSource, readers: BoardReaders = defaultReaders): SourceRead {
  try {
    const rows = s.kind === "github" ? readers.github(s.slug, s.repo, githubReadOptions(s)) : readers.jira(s.project, s.repos, jiraReadOptions(s));

    return { rows, notes: [], failedRepos: [] };
  } catch (e) {
    return { rows: [], notes: [`${sourceName(s)}: ${errorMessage(e).split("\n")[0]}`], failedRepos: s.kind === "github" ? [s.repo] : s.repos };
  }
}

/** Read every source. A source that fails adds a note and does not stop the rest. */
export function readBoards(sources: readonly BoardSource[], readers: BoardReaders = defaultReaders): SourceRead {
  return mergeReads(sources.map((s) => readSource(s, readers)));
}

export const mergeReads = (results: readonly SourceRead[]): SourceRead => ({
  rows: results.flatMap((r) => r.rows),
  notes: results.flatMap((r) => r.notes),
  failedRepos: results.flatMap((r) => r.failedRepos),
});

/**
 * The server's cache key for a source's read. A GitHub source is its slug, the local repo (two registered repos may share a URL, and a read's rows carry the repo name) and what shapes the rows (scope, project board,
 * column mapping); a Jira source is its project, filter and site, so every repo that names the same project and filter
 * shares one read (`boardSources` has already grouped them).
 */
export function sourceKey(s: BoardSource): string {
  const digest = <T>(parts: T) => new Bun.CryptoHasher("sha1").update(JSON.stringify(parts ?? null)).digest("hex").slice(0, 10);

  return s.kind === "github"
    ? `board:gh:${s.slug}:${s.repo}:${digest([s.scope, s.project, s.columns])}`
    : `board:jira:${s.project}:${digest([s.filter, s.site])}`;
}

/**
 * The rows to cache after a refresh: the fresh ones, plus the last good rows of every repo whose read failed,
 * so a rate limit or an outage never empties the panel. Fresh rows win on a repeated key.
 */
export function keepLastGood(previous: readonly WorkRow[], fresh: readonly WorkRow[], failedRepos: readonly string[]): WorkRow[] {
  const failed = new Set(failedRepos);
  const have = new Set(fresh.map((r) => keyOf(r)));

  return [...fresh, ...previous.filter((r) => failed.has(r.repo) && !have.has(keyOf(r)))];
}

/** Keep GitHub boards owned by one of `orgs` (any case); no orgs keeps all. Jira sources have no GitHub owner, so they always stay. */
export function filterBoardsByOrg(sources: readonly BoardSource[], orgs: readonly string[]): BoardSource[] {
  if (orgs.length === 0) return [...sources];
  const owners = new Set(orgs.map((o) => o.toLowerCase()));

  return sources.filter((s) => s.kind !== "github" || owners.has((s.slug.split("/")[0] ?? "").toLowerCase()));
}

/** The reads a refresh makes, and the notes for repos whose config cannot be read: one line per repo. */
export function planWorklist(): WorklistPlan {
  const boards: RepoBoard[] = [];
  const notes: string[] = [];

  for (const spec of Object.values(loadRepos())) {
    try {
      const config = committedConfig(spec);
      const pm = config.projectManagement;
      const board: RepoBoard = { repo: spec.name, url: spec.url, columns: config.boardColumns };

      if (pm) board.pm = pm;
      boards.push(board);
    } catch (e) {
      notes.push(`${spec.name}: ${errorMessage(e).split("\n")[0]}`);
    }
  }

  const planned = boardSources(boards);

  return { sources: filterBoardsByOrg(planned.sources, loadRootLayers().githubOrgs), notes: [...notes, ...planned.notes] };
}

/** Write the cache from a plan's notes and what its reads returned, keeping the last good rows of a failed repo. */
export function finishWorklist(planNotes: readonly string[], read: SourceRead, now = Date.now()): WorklistCache {
  const cache = { at: now, rows: keepLastGood(readWorklist().rows, read.rows, read.failedRepos), notes: [...planNotes, ...read.notes] };
  writeWorklist(cache);

  return cache;
}

/** Read every registered repo's board into the cache. A repo whose config cannot be read adds a note. */
export function refreshWorklist(now = Date.now()): WorklistCache {
  const plan = planWorklist();

  return finishWorklist(plan.notes, readBoards(plan.sources), now);
}
