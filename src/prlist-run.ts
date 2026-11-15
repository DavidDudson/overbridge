import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRootLayers } from "./project-config";
import { metaDir, selfCommand } from "./paths";
import { errorMessage, run, spawnCwd, type RunResult } from "./util";
import { age, CHROME, type PrRow } from "./pr-rows";
import { filterOrgs, mergeRows, reviewCommand, rowsFromReviews } from "./review-batch";
import { prsView } from "./prs-view";
import { readMyPrs } from "./prs-refresh";
import { reviewsView } from "./reviews-view";
import { decodeInput, ENTER_SCREEN, frame, LEAVE_SCREEN } from "./term";

export { age, type PrRow };

/** The two PR lists in the orchestration tabs: PRs you opened, and PRs waiting for your review. */
export type PrListKind = "prs" | "reviews";

export const PRLIST_REFRESH_MS = 60_000;

export interface PrListCache {
  at: number;
  rows: PrRow[];
  /** Why the last read failed, if it did. */
  error?: string;
}

export const prListPath = (kind: PrListKind) => join(metaDir(), `prlist-${kind}.json`);

export function readPrList(kind: PrListKind): PrListCache {
  try {
    return JSON.parse(readFileSync(prListPath(kind), "utf8"));
  } catch {
    return { at: 0, rows: [] };
  }
}

function writePrList(kind: PrListKind, cache: PrListCache) {
  mkdirSync(metaDir(), { recursive: true });
  const tmp = `${prListPath(kind)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n");
  renameSync(tmp, prListPath(kind));
}

export const SEARCH_FIELDS = "number,title,url,repository,author,isDraft,updatedAt";

/** The `gh search prs` command for a list. No orgs means every owner `gh` can see. */
export function searchCommand(kind: PrListKind, orgs: readonly string[]): string[] {
  return [
    "gh", "search", "prs",
    kind === "prs" ? "--author=@me" : "--review-requested=@me",
    "--state=open",
    ...orgs.map((o) => `--owner=${o}`),
    "--sort=updated",
    "--limit=100",
    "--json", SEARCH_FIELDS,
  ];
}

interface SearchHit {
  number: number;
  title: string;
  url: string;
  repository: { nameWithOwner: string };
  author: { login: string };
  isDraft: boolean;
  updatedAt: string;
}

/** Rows from `gh search prs --json` output. */
export function rowsFromSearch(json: string): PrRow[] {
  const hits: SearchHit[] = JSON.parse(json);

  return hits.map((h) => ({
    repo: h.repository.nameWithOwner,
    number: h.number,
    title: h.title,
    url: h.url,
    author: h.author?.login ?? "",
    draft: h.isDraft,
    updatedAt: h.updatedAt,
  }));
}

type Runner = (cmd: string[]) => RunResult;

const firstLine = (r: RunResult) => (r.stderr || r.stdout).trim().split("\n")[0];

/** The reviews asked of me: one GraphQL search per owner, so each row carries its request, bots, CI and merge state. */
export function readReviews(orgs: readonly string[], runner: Runner = run): PrRow[] {
  const who = runner(["gh", "api", "user", "--jq", ".login"]);

  if (!who.ok) throw new Error(`gh api user failed: ${firstLine(who)}`);
  const me = who.stdout.trim();

  const lists = (orgs.length ? orgs : [undefined]).map((org) => {
    const r = runner(reviewCommand(me, org));

    if (!r.ok) throw new Error(`gh api graphql failed: ${firstLine(r)}`);

    return rowsFromReviews(r.stdout, me);
  });

  return filterOrgs(mergeRows(lists), orgs);
}

/** Read one list. Throws with `gh`'s message when the search fails. */
export function readPrs(kind: PrListKind, orgs: readonly string[], runner: Runner = run): PrRow[] {
  if (kind === "reviews") return readReviews(orgs, runner);

  if (kind === "prs") return readMyPrs(orgs, runner);

  const r = runner(searchCommand(kind, orgs));

  if (!r.ok) throw new Error(`gh search prs failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);

  return rowsFromSearch(r.stdout);
}

/** `overbridge prs refresh` / `reviews refresh`: read the list into its cache. A failed read keeps the old rows. */
export function refreshPrList(kind: PrListKind, now = Date.now()): PrListCache {
  const orgs = loadRootLayers().githubOrgs;
  let cache: PrListCache;

  try {
    cache = { at: now, rows: readPrs(kind, orgs) };
  } catch (e) {
    cache = { ...readPrList(kind), at: now, error: errorMessage(e) };
  }

  writePrList(kind, cache);

  return cache;
}

/** Runs `overbridge <kind> refresh` in a child, so the pane keeps drawing while `gh` runs. */
export async function refreshPrListInChild(kind: PrListKind): Promise<{ ok: boolean; error: string }> {
  const child = Bun.spawn({ cmd: [...selfCommand(), kind, "refresh"], cwd: spawnCwd(), stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  const first = stderr.split("\n").find((l) => l.trim())?.trim();

  return code === 0 ? { ok: true, error: "" } : { ok: false, error: first ?? `${kind} refresh exited with code ${code}` };
}

/** The view of each list: how its rows are ordered for the cursor and drawn. */
const VIEWS = { prs: prsView, reviews: reviewsView } as const;

/** The panel as screen rows. Pure, so it is snapshot-tested. */
export function renderPrList(kind: PrListKind, rows: readonly PrRow[], selected: number, offset: number, height: number, width: number, message = "", now = Date.now()): string[] {
  return VIEWS[kind].render(rows, { selected, offset, height, width, message, now });
}

/** `overbridge prs` / `overbridge reviews`: the pane of an orchestration tab. */
export async function prListPane(kind: PrListKind) {
  const view = VIEWS[kind];
  let cache = readPrList(kind);
  const rowsOf = () => view.order(cache.rows);
  let selected = 0;
  let offset = 0;
  let message = cache.error ? `error: ${cache.error}` : "";
  let busy = false;
  let startedAt = 0;

  const draw = () => {
    const height = process.stdout.rows ?? 24;
    const width = process.stdout.columns ?? 80;
    const rows = rowsOf();
    selected = Math.min(selected, Math.max(0, rows.length - 1));
    const body = Math.max(1, height - CHROME);

    if (selected < offset) offset = selected;

    if (selected >= offset + body) offset = selected - body + 1;
    process.stdout.write(frame(view.render(rows, { selected, offset, height, width, message, now: Date.now() }), height, width));
  };

  const refresh = () => {
    if (busy) return;
    busy = true;
    startedAt = Date.now();
    message = "refreshing…";
    draw();
    void refreshPrListInChild(kind).then((result) => {
      cache = readPrList(kind);
      message = result.ok ? (cache.error ? `error: ${cache.error}` : "") : `error: ${result.error}`;
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
  process.stdin.on("data", (data: string) => {
    for (const input of decodeInput(data)) {
      if (input.kind !== "key") continue;

      if (input.key === "q" || input.key === "ctrl-c") quit();
      else if (input.key === "j" || input.key === "down") selected = Math.min(rowsOf().length - 1, selected + 1);
      else if (input.key === "k" || input.key === "up") selected = Math.max(0, selected - 1);
      else if (input.key === "r") refresh();
      else if (input.key === "o" && rowsOf()[selected]) {
        Bun.spawn({ cmd: ["gh", "pr", "view", "--web", rowsOf()[selected]!.url], cwd: spawnCwd(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      }
    }

    draw();
  });
  process.stdout.on("resize", draw);
  setInterval(() => {
    if (Date.now() - Math.max(cache.at, startedAt) >= PRLIST_REFRESH_MS) refresh();
  }, 1000);
  setInterval(() => {
    const latest = readPrList(kind);

    if (latest.at > cache.at) cache = latest;
    draw();
  }, 5000);
  setInterval(() => {
    if (busy || view.animated(rowsOf())) draw();
  }, 250);
  draw();

  if (cache.at === 0) refresh();
  await new Promise(() => {});
}
