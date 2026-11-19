import { selfCommand } from "./paths";
import { type PrListKind, readPrList } from "./prlist-data";
import { spawnCwd } from "./util";
import { age, CHROME, type PrRow } from "./pr-rows";
import { spinner } from "./anim";
import { serverRefreshPrList } from "./server-client";
import { mentionScanError, silencedSet, spawnMentionRefresh, toggleMessage } from "./silence-refresh";
import { prsView } from "./prs-view";
import { DEFAULT_REVIEWS_SORT, reviewsView } from "./reviews-view";
import { sortPrRows } from "./pr-sort";
import { nextSort, type SortMode } from "./sort-mode";
import { decodeInput, ENTER_SCREEN, frame, LEAVE_SCREEN } from "./term";

export { age, type PrRow };

export * from "./prlist-data";

export { readPrs, readReviews, refreshPrList } from "./prlist-refresh";

export const PRLIST_REFRESH_MS = 60_000;

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

/** Runs `overbridge <kind> refresh` in a child, so the pane keeps drawing while `gh` runs. */
export async function refreshPrListInChild(kind: PrListKind, o: { force?: boolean } = {}): Promise<{ ok: boolean; error: string }> {
  const child = Bun.spawn({ cmd: [...selfCommand(), kind, "refresh", ...(o.force ? ["--force"] : [])], cwd: spawnCwd(), stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  const first = stderr.split("\n").find((l) => l.trim())?.trim();

  return code === 0 ? { ok: true, error: "" } : { ok: false, error: first ?? `${kind} refresh exited with code ${code}` };
}

/** Refresh through the server when one answers, so the rate-limit pause applies; else in a child. */
export async function refreshPrListAny(kind: PrListKind, o: { force?: boolean } = {}, server = serverRefreshPrList, child = refreshPrListInChild): Promise<{ ok: boolean; error: string }> {
  return (await server(kind, o)) ?? (await child(kind, o));
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
  let sort: SortMode = DEFAULT_REVIEWS_SORT;
  // only the reviews tab sorts; the PRs list keeps the order its source gave
  const rowsOf = () => view.order(kind === "reviews" ? sortPrRows(cache.rows, sort) : cache.rows);
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
    process.stdout.write(frame(view.render(rows, { selected, offset, height, width, message: busy ? `${spinner(Date.now())} ${message}` : message, now: Date.now(), sort, silenced: silencedSet(rows) }), height, width));
  };

  /** Replace the rows; the cursor stays on the same PR when the new order moves it. */
  const installCache = (next: typeof cache) => {
    const url = rowsOf()[selected]?.url;
    cache = next;
    const moved = rowsOf().findIndex((r) => r.url === url);

    if (moved >= 0) selected = moved;
  };

  const refresh = (force = false) => {
    if (busy) return;
    busy = true;
    startedAt = Date.now();
    message = "refreshing…";
    draw();
    void refreshPrListAny(kind, { force }).then((result) => {
      installCache(readPrList(kind));
      message = result.ok ? (cache.error ? `error: ${cache.error}` : mentionScanError()) : `error: ${result.error}`;
      busy = false;
      message ||= spawnMentionRefresh();
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
      const chosen = rowsOf()[selected];

      if (input.key === "q" || input.key === "ctrl-c") quit();
      else if (input.key === "j" || input.key === "down") selected = Math.max(0, Math.min(rowsOf().length - 1, selected + 1));
      else if (input.key === "k" || input.key === "up") selected = Math.max(0, selected - 1);
      else if (input.key === "s" && kind === "reviews") {
        // the cursor stays on the same PR when the order changes under it
        const url = rowsOf()[selected]?.url;
        sort = nextSort(sort);
        selected = Math.max(0, rowsOf().findIndex((r) => r.url === url));
      } else if (input.key === "x" && chosen) {
        message = toggleMessage(chosen, `${chosen.repo}#${chosen.number}`);
      } else if (input.key === "r") refresh(true);
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

    if (latest.at > cache.at) installCache(latest);
    draw();
  }, 5000);
  setInterval(() => {
    if (busy || view.animated(rowsOf())) draw();
  }, 250);
  draw();

  if (cache.at === 0) refresh();
  await new Promise(() => {});
}
