import { selfCommand } from "./paths";
import { detailLines, filterRanked } from "./pm/worklist-filter";
import { keyOf, rank, type Ranked, type WorkRow, type WorkStatus } from "./pm/worklist";
import { FooterKind, runStart } from "./sidebar";
import { serverRefreshWorklist } from "./server-client";
import { readWorklist, WORKLIST_REFRESH_MS, type WorklistCache } from "./worklist-data";
export * from "./worklist-data";
import { spawnCwd } from "./util";
import { bold, boxBottom, boxRow, boxTop, colorize, decodeInput, dim, ENTER_SCREEN, fit, frame, inverse, LEAVE_SCREEN, type Color } from "./term";

/** Rows the frame uses besides the item rows: top border, header, reasons, legend, bottom border. */
const CHROME = 5;

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
/** Refresh through the server when one answers, else in a child. The server reads each board once per window however many callers ask. */
export async function refreshWorklistAny(o: { force?: boolean } = {}, server: (o: { force?: boolean }) => Promise<RefreshResult | undefined> = serverRefreshWorklist, child: () => Promise<RefreshResult> = refreshInChild): Promise<RefreshResult> {
  return (await server(o)) ?? (await child());
}

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
export function renderWorklist(list: Ranked[], selected: number, offset: number, height: number, width: number, message = "", notes: string[] = [], filter = ""): string[] {
  const inner = width - 4;
  const body = Math.max(1, height - CHROME);
  const rows: string[] = [boxTop("Work", width), boxRow(dim(fit(`${"#".padEnd(3)} ${"ready".padEnd(5)} ${"stream".padEnd(6)} ${"item".padEnd(14)} title`, inner)))];
  const visible = list.slice(offset, offset + body);
  for (const [i, r] of visible.entries()) {
    const line = `${String(r.rank).padEnd(3)} ${(r.ready ? "yes" : r.status === "in-progress" ? "wip" : "no").padEnd(5)} ${`s${r.stream}`.padEnd(6)} ${r.key.slice(0, 14).padEnd(14)} ${r.title}`;
    const text = fit(line, inner);
    rows.push(boxRow(offset + i === selected ? inverse(text) : colorize(text, STATUS_COLOR[r.status] ?? "grey")));
  }
  for (let i = visible.length; i < body; i++) rows.push(boxRow(list.length === 0 && i === 0 ? dim(fit(filter ? `nothing matches /${filter}` : "nothing assigned to you", inner)) : fit("", inner)));
  const chosen = list[selected];
  rows.push(boxRow(fit(chosen ? `why: ${chosen.reasons.join(", ")}` : "", inner)));
  const shown = message || (notes[0] ? `error: ${notes[0]}${notes.length > 1 ? ` (+${notes.length - 1} more)` : ""}; showing the last good list` : "");
  const status = shown.startsWith("error: ") ? colorize(fit(shown, inner), "red") : shown ? bold(fit(shown, inner)) : dim(fit("j/k move   enter detail   / filter   s start   r refresh   q quit", inner));
  rows.push(boxRow(status));
  rows.push(boxBottom(width, filter ? `${list.length} match /${filter}` : `${list.length} open`));
  return rows;
}

/** The detail view as screen rows: the item's facts, then a legend. Pure, so it is tested. */
export function renderDetail(item: Ranked, all: readonly Ranked[], height: number, width: number): string[] {
  const inner = width - 4;
  const body = Math.max(1, height - 3);
  const lines = detailLines(item, all).slice(0, body);
  return [boxTop("Work item", width), ...lines.map((l) => boxRow(fit(l, inner))), ...Array.from({ length: body - lines.length }, () => boxRow(fit("", inner))), boxRow(dim(fit("esc back   s start in a workspace   q quit", inner))), boxBottom(width, item.key)];
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
  /** The `/` filter; while `typing`, keys edit it instead of moving. */
  let filter = "";
  let typing = false;
  /** The item whose detail view is open. */
  let detail: Ranked | undefined;
  const everything = () => rank(cache.rows);
  const ranked = () => filterRanked(everything(), filter);

  const draw = () => {
    const list = ranked();
    const height = process.stdout.rows ?? 24;
    selected = Math.min(selected, Math.max(0, list.length - 1));
    const body = Math.max(1, height - CHROME);
    if (selected < offset) offset = selected;
    if (selected >= offset + body) offset = selected - body + 1;
    const width = process.stdout.columns ?? 80;
    const shown = typing ? `/${filter}▏` : "";
    const rows = detail ? renderDetail(detail, everything(), height, width) : renderWorklist(list, selected, offset, height, width, typing ? shown : message, cache.notes, filter);
    process.stdout.write(frame(rows, height, width));
  };

  /** When the last refresh started, so a failing one waits a full interval before the next try. */
  let refreshStartedAtMs = 0;

  const refresh = (force = false) => {
    if (busy) return;
    busy = true;
    refreshStartedAtMs = Date.now();
    message = "refreshing…";
    draw();
    void refreshWorklistAny({ force }).then((result) => {
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
      if (typing) {
        if (input.key === "enter") typing = false;
        else if (input.key === "escape" || input.key === "ctrl-c") {
          typing = false;
          filter = "";
        } else if (input.key === "\x7f" || input.key === "\b") filter = filter.slice(0, -1);
        else if ([...input.key].length === 1) filter += input.key;
        selected = 0;
        offset = 0;
        continue;
      }
      if (detail) {
        if (input.key === "escape" || input.key === "enter" || input.key === "h" || input.key === "left") detail = undefined;
        else if (input.key === "q" || input.key === "ctrl-c") quit();
        else if (input.key === "s") {
          const item = detail;
          const repos = item.repos ?? [item.repo];
          detail = undefined;
          if (repos.length === 1) await startIn(repos[0]!, item);
          else {
            picking = item;
            message = repoPrompt(item.key, repos);
          }
        }
        continue;
      }
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
      else if (input.key === "r") refresh(true);
      else if (input.key === "/") typing = true;
      else if (input.key === "escape" && filter) filter = "";
      else if ((input.key === "enter" || input.key === "l" || input.key === "right") && list[selected]) detail = list[selected];
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
