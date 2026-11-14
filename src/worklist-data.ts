import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { committedConfig } from "./committed-config";
import { loadRepos } from "./config";
import { metaDir } from "./paths";
import { githubRows, parseProject, projectRows, slugFromUrl, type ProjectBoard, type WorklistScope } from "./pm/board-github";
import { jiraRows } from "./pm/board-jira";
import { keyOf, type WorkRow, type WorkStatus } from "./pm/worklist";
import type { ProjectManagement } from "./project-config";

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

const cacheFile = () => join(metaDir(), "worklist.json");

export function readWorklist(): WorklistCache {
  try {
    return JSON.parse(readFileSync(cacheFile(), "utf8"));
  } catch {
    return { at: 0, rows: [], notes: [] };
  }
}

function writeWorklist(cache: WorklistCache) {
  mkdirSync(metaDir(), { recursive: true });
  const tmp = `${cacheFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n");
  renameSync(tmp, cacheFile());
}

/** One board read: a GitHub repo, or a Jira project shared by every repo that names it. */
export type BoardSource =
  | { kind: "github"; repo: string; slug: string; columns?: Record<string, WorkStatus>; scope?: WorklistScope; project?: ProjectBoard }
  | { kind: "jira"; project: string; repos: string[]; filter?: string; site?: string };

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
export function boardSources(repos: readonly RepoBoard[]): { sources: BoardSource[]; notes: string[] } {
  const withPm = repos.filter((r): r is RepoBoard & { pm: ProjectManagement } => r.pm !== undefined);
  const github = withPm
    .filter((r) => r.pm.name === "github")
    .map((r) => ({ r, slug: slugFromUrl(r.url) ?? (/^[\w.-]+\/[\w.-]+$/.test(r.pm.project) ? r.pm.project : undefined) }));
  const jiraRepos = withPm.filter((r) => r.pm.name === "jira");
  const jiraGroups = Map.groupBy(jiraRepos, (r) => JSON.stringify([r.pm.project.toUpperCase(), r.pm.worklistJql ?? null, r.pm.url ?? null]));
  const jira = [...jiraGroups.values()].map((group): BoardSource => {
    const pm = group[0]!.pm;
    return {
      kind: "jira",
      project: pm.project.toUpperCase(),
      repos: group.map((r) => r.repo),
      ...(pm.worklistJql !== undefined ? { filter: pm.worklistJql } : {}),
      ...(pm.url ? { site: pm.url } : {}),
    };
  });
  return {
    sources: [
      ...github.flatMap(({ r, slug }): BoardSource[] => {
        if (!slug) return [];
        const project = r.pm.worklistProject ? parseProject(r.pm.worklistProject, slug.split("/")[0], r.pm.worklistStatuses) : undefined;
        return [
          {
            kind: "github",
            repo: r.repo,
            slug,
            ...(r.columns && Object.keys(r.columns).length ? { columns: r.columns } : {}),
            ...(r.pm.worklistScope ? { scope: r.pm.worklistScope } : {}),
            ...(project ? { project } : {}),
          },
        ];
      }),
      ...jira,
    ],
    notes: [
      ...github.filter((g) => !g.slug).map(({ r }) => `${r.repo}: cannot tell the GitHub repo from ${r.url}`),
      ...github.filter((g) => g.slug && g.r.pm.worklistProject && !parseProject(g.r.pm.worklistProject, g.slug.split("/")[0])).map(({ r }) => `${r.repo}: bad worklist-project ${r.pm.worklistProject}`),
    ],
  };
}

export interface BoardReaders {
  github: (slug: string, repo: string, opts?: { columns?: Record<string, WorkStatus>; scope?: WorklistScope; project?: ProjectBoard }) => WorkRow[];
  jira: (project: string, repos: string[], opts: { filter?: string; site?: string }) => WorkRow[];
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

/** Read one source. A source that fails adds a note and no rows. */
export function readSource(s: BoardSource, readers: BoardReaders = defaultReaders): SourceRead {
  try {
    const rows = s.kind === "github" ? readers.github(s.slug, s.repo, { ...(s.columns ? { columns: s.columns } : {}), ...(s.scope ? { scope: s.scope } : {}), ...(s.project ? { project: s.project } : {}) }) : readers.jira(s.project, s.repos, { ...(s.filter !== undefined ? { filter: s.filter } : {}), ...(s.site ? { site: s.site } : {}) });
    return { rows, notes: [], failedRepos: [] };
  } catch (e) {
    return { rows: [], notes: [`${sourceName(s)}: ${(e as Error).message.split("\n")[0]}`], failedRepos: s.kind === "github" ? [s.repo] : s.repos };
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
  const shape = (v: unknown) => new Bun.CryptoHasher("sha1").update(JSON.stringify(v ?? null)).digest("hex").slice(0, 10);
  return s.kind === "github"
    ? `board:gh:${s.slug}:${s.repo}:${shape([s.scope, s.project, s.columns])}`
    : `board:jira:${s.project}:${shape([s.filter, s.site])}`;
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

/** The reads a refresh makes, and the notes for repos whose config cannot be read: one line per repo. */
export function planWorklist(): { sources: BoardSource[]; notes: string[] } {
  const configs = Object.values(loadRepos()).map((spec): RepoBoard | string => {
    try {
      const config = committedConfig(spec);
      const pm = config.projectManagement;
      return { repo: spec.name, url: spec.url, ...(pm ? { pm } : {}), columns: config.boardColumns };
    } catch (e) {
      return `${spec.name}: ${(e as Error).message.split("\n")[0]}`;
    }
  });
  const planned = boardSources(configs.filter((c): c is RepoBoard => typeof c !== "string"));
  return { sources: planned.sources, notes: [...configs.filter((c): c is string => typeof c === "string"), ...planned.notes] };
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
