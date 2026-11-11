import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRepos } from "./config";
import { metaDir, selfCommand } from "./paths";
import { githubRows, slugFromUrl } from "./pm/board-github";
import { jiraRows } from "./pm/board-jira";
import { rank, type Ranked, type WorkRow } from "./pm/worklist";
import { FooterKind, runStart } from "./sidebar";
import type { ProjectManagement } from "./project-config";
import { committedConfig } from "./start";
import { spawnCwd } from "./util";
import { bold, boxBottom, boxRow, boxTop, colorize, decodeInput, dim, ENTER_SCREEN, fit, frame, inverse, LEAVE_SCREEN, type Color } from "./term";

/** Rows the frame uses besides the item rows: top border, header, reasons, legend, bottom border. */
const CHROME = 5;

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
  | { kind: "github"; repo: string; slug: string }
  | { kind: "jira"; project: string; repos: string[]; filter?: string; site?: string };

export interface RepoBoard {
  repo: string;
  url: string;
  pm?: ProjectManagement;
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
    sources: [...github.flatMap(({ r, slug }): BoardSource[] => (slug ? [{ kind: "github", repo: r.repo, slug }] : [])), ...jira],
    notes: github.filter((g) => !g.slug).map(({ r }) => `${r.repo}: cannot tell the GitHub repo from ${r.url}`),
  };
}

export interface BoardReaders {
  github: (slug: string, repo: string) => WorkRow[];
  jira: (project: string, repos: string[], opts: { filter?: string; site?: string }) => WorkRow[];
}

const defaultReaders: BoardReaders = { github: (slug, repo) => githubRows(slug, repo), jira: (project, repos, opts) => jiraRows(project, repos, opts) };

const sourceName = (s: BoardSource) => (s.kind === "github" ? s.repo : s.project);

/** Read every source. A source that fails adds a note and does not stop the rest. */
export function readBoards(sources: readonly BoardSource[], readers: BoardReaders = defaultReaders): { rows: WorkRow[]; notes: string[] } {
  const results = sources.map((s): { rows: WorkRow[]; notes: string[] } => {
    try {
      const rows = s.kind === "github" ? readers.github(s.slug, s.repo) : readers.jira(s.project, s.repos, { ...(s.filter !== undefined ? { filter: s.filter } : {}), ...(s.site ? { site: s.site } : {}) });
      return { rows, notes: [] };
    } catch (e) {
      return { rows: [], notes: [`${sourceName(s)}: ${(e as Error).message.split("\n")[0]}`] };
    }
  });
  return { rows: results.flatMap((r) => r.rows), notes: results.flatMap((r) => r.notes) };
}

/** Read every registered repo's board into the cache. A repo whose config cannot be read adds a note. */
export function refreshWorklist(now = Date.now()): WorklistCache {
  const configs = Object.values(loadRepos()).map((spec): RepoBoard | string => {
    try {
      const pm = committedConfig(spec).projectManagement;
      return { repo: spec.name, url: spec.url, ...(pm ? { pm } : {}) };
    } catch (e) {
      return `${spec.name}: ${(e as Error).message.split("\n")[0]}`;
    }
  });
  const planned = boardSources(configs.filter((c): c is RepoBoard => typeof c !== "string"));
  const read = readBoards(planned.sources);
  const cache = { at: now, rows: read.rows, notes: [...configs.filter((c): c is string => typeof c === "string"), ...planned.notes, ...read.notes] };
  writeWorklist(cache);
  return cache;
}

/** The list `overbridge worklist show` prints for a Claude: one ranked row per line, then the repos that could not be read. */
export function showWorklist(cache: WorklistCache): string[] {
  const rows = rank(cache.rows).map((r) => `${r.rank}\t${r.ready ? "ready" : r.status}\t${r.key}\t${r.title}\t${r.reasons.join(", ")}`);
  return [...(rows.length ? rows : ["nothing assigned to you"]), ...cache.notes.map((n) => `note: ${n}`)];
}

export interface RefreshResult {
  ok: boolean;
  /** The first line the child printed to stderr, or its exit code, when it failed. */
  error: string;
}

/** Starts a process and resolves with its exit code and stderr. */
export type RefreshSpawner = (cmd: string[]) => Promise<{ code: number; stderr: string }>;

const spawnRefresh: RefreshSpawner = async (cmd) => {
  const child = Bun.spawn({ cmd, cwd: spawnCwd(), stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr };
};

/** Runs `overbridge worklist refresh` in a child, so the pane keeps drawing and taking keys while the boards are read. */
export async function refreshInChild(spawn: RefreshSpawner = spawnRefresh, self: string[] = selfCommand()): Promise<RefreshResult> {
  const { code, stderr } = await spawn([...self, "worklist", "refresh"]);
  const firstLine = stderr.split("\n").find((l) => l.trim())?.trim();
  return code === 0 ? { ok: true, error: "" } : { ok: false, error: firstLine ?? `worklist refresh exited with code ${code}` };
}

/** The prompt shown while choosing which repo to start an item in. Digits pick; the list is at most nine long. */
export const repoPrompt = (key: string, repos: readonly string[]) =>
  `start ${key} in: ${repos.slice(0, 9).map((r, i) => `${i + 1} ${r}`).join("  ")}   esc cancel`;

/** The repo a digit key picks from `repos`, or undefined when the key is not one of the offered digits. */
export function pickRepo(key: string, repos: readonly string[]): string | undefined {
  const n = /^[1-9]$/.test(key) ? Number(key) : 0;
  return n > 0 && n <= Math.min(9, repos.length) ? repos[n - 1] : undefined;
}

const STATUS_COLOR: Record<string, Color> = { todo: "grey", "in-progress": "yellow", blocked: "red", done: "green" };

/**
 * The panel as screen rows: a table of ranked items with the selected row inverted, then the selected
 * row's reasons and a legend. Pure, so it is snapshot-tested.
 */
export function renderWorklist(list: Ranked[], selected: number, offset: number, height: number, width: number, message = "", notes: string[] = []): string[] {
  const inner = width - 4;
  const body = Math.max(1, height - CHROME);
  const rows: string[] = [boxTop("Work", width), boxRow(dim(fit(`${"#".padEnd(3)} ${"ready".padEnd(5)} ${"stream".padEnd(6)} ${"item".padEnd(14)} title`, inner)))];
  const visible = list.slice(offset, offset + body);
  for (const [i, r] of visible.entries()) {
    const line = `${String(r.rank).padEnd(3)} ${(r.ready ? "yes" : r.status === "in-progress" ? "wip" : "no").padEnd(5)} ${`s${r.stream}`.padEnd(6)} ${r.key.slice(0, 14).padEnd(14)} ${r.title}`;
    const text = fit(line, inner);
    rows.push(boxRow(offset + i === selected ? inverse(text) : colorize(text, STATUS_COLOR[r.status] ?? "grey")));
  }
  for (let i = visible.length; i < body; i++) rows.push(boxRow(list.length === 0 && i === 0 ? dim(fit("nothing assigned to you", inner)) : fit("", inner)));
  const chosen = list[selected];
  rows.push(boxRow(fit(chosen ? `why: ${chosen.reasons.join(", ")}` : (notes[0] ?? ""), inner)));
  const status = message.startsWith("error: ") ? colorize(fit(message, inner), "red") : message ? bold(fit(message, inner)) : dim(fit("j/k move   s start in a workspace   r refresh   q quit", inner));
  rows.push(boxRow(status));
  rows.push(boxBottom(width, `${list.length} open`));
  return rows;
}

/** `overbridge worklist`: the @work tab's pane. */
export async function worklistPane() {
  let cache = readWorklist();
  let selected = 0;
  let offset = 0;
  let message = "";
  let busy = false;
  /** The item waiting for a repo choice, when it can be started in more than one. */
  let picking: Ranked | undefined;
  const ranked = () => rank(cache.rows);

  const draw = () => {
    const list = ranked();
    const height = process.stdout.rows ?? 24;
    selected = Math.min(selected, Math.max(0, list.length - 1));
    const body = Math.max(1, height - CHROME);
    if (selected < offset) offset = selected;
    if (selected >= offset + body) offset = selected - body + 1;
    process.stdout.write(frame(renderWorklist(list, selected, offset, height, process.stdout.columns ?? 80, message, cache.notes), height, process.stdout.columns ?? 80));
  };

  /** When the last refresh started, so a failing one waits a full interval before the next try. */
  let refreshStartedAtMs = 0;

  const refresh = () => {
    if (busy) return;
    busy = true;
    refreshStartedAtMs = Date.now();
    message = "refreshing…";
    draw();
    void refreshInChild().then((result) => {
      cache = readWorklist();
      message = result.ok ? "" : `error: ${result.error}`;
      busy = false;
      draw();
    });
  };

  const quit = () => {
    process.stdout.write(LEAVE_SCREEN);
    process.stdin.setRawMode?.(false);
    process.exit(0);
  };

  process.stdout.write(ENTER_SCREEN);
  process.stdin.setRawMode?.(true);
  process.stdin.setEncoding("utf8");
  const startIn = async (repo: string, item: Ranked) => {
    message = `starting ${item.key} in ${repo}…`;
    draw();
    const footer = await runStart(repo, item.id);
    message = footer.kind === FooterKind.Error ? `error: ${footer.message}` : `started ${item.key} in ${repo}`;
  };

  process.stdin.on("data", async (data: string) => {
    for (const input of decodeInput(data)) {
      if (input.kind !== "key") continue;
      const list = ranked();
      if (picking) {
        const item = picking;
        const repo = pickRepo(input.key, item.repos ?? []);
        if (repo) {
          picking = undefined;
          await startIn(repo, item);
        } else if (input.key === "escape" || input.key === "q" || input.key === "ctrl-c") {
          picking = undefined;
          message = "";
        }
        continue;
      }
      if (input.key === "q" || input.key === "ctrl-c") quit();
      else if (input.key === "j" || input.key === "down") selected = Math.min(list.length - 1, selected + 1);
      else if (input.key === "k" || input.key === "up") selected = Math.max(0, selected - 1);
      else if (input.key === "r") refresh();
      else if (input.key === "s" && list[selected]) {
        const item = list[selected]!;
        const repos = item.repos ?? [item.repo];
        if (repos.length === 1) {
          await startIn(repos[0]!, item);
        } else {
          picking = item;
          message = repoPrompt(item.key, repos);
        }
      }
    }
    draw();
  });
  process.stdout.on("resize", draw);
  setInterval(() => {
    if (Date.now() - Math.max(cache.at, refreshStartedAtMs) >= WORKLIST_REFRESH_MS) refresh();
  }, 1000);
  setInterval(() => {
    cache = readWorklist().at > cache.at ? readWorklist() : cache;
    draw();
  }, 5000);
  draw();
  if (cache.at === 0) refresh();
  await new Promise(() => {});
}
