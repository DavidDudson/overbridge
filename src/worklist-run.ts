import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRepos } from "./config";
import { metaDir } from "./paths";
import { githubRows, slugFromUrl } from "./pm/board-github";
import { rank, type Ranked, type WorkRow } from "./pm/worklist";
import { FooterKind, runStart } from "./sidebar";
import { committedConfig } from "./start";
import { bold, boxBottom, boxRow, boxTop, colorize, decodeInput, dim, ENTER_SCREEN, fit, frame, inverse, LEAVE_SCREEN, type Color } from "./term";

/** Rows the frame uses besides the item rows: top border, header, reasons, legend, bottom border. */
const CHROME = 5;

/** The panel is a prototype (spike #108): one list, refreshed in the background, never fetched while drawing. */
export const WORKLIST_REFRESH_MS = 60_000;

export interface WorklistCache {
  at: number;
  rows: WorkRow[];
  /** One line per repo that could not be read or is not supported yet. */
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

/** Read every registered repo's board into the cache. A repo that fails adds a note and does not stop the rest. */
export function refreshWorklist(now = Date.now()): WorklistCache {
  const rows: WorkRow[] = [];
  const notes: string[] = [];
  for (const spec of Object.values(loadRepos())) {
    try {
      const pm = committedConfig(spec).projectManagement;
      if (!pm) continue;
      if (pm.name !== "github") {
        notes.push(`${spec.name}: ${pm.name} board not read yet`);
        continue;
      }
      const slug = slugFromUrl(spec.url) ?? (/^[\w.-]+\/[\w.-]+$/.test(pm.project) ? pm.project : undefined);
      if (!slug) notes.push(`${spec.name}: cannot tell the GitHub repo from ${spec.url}`);
      else rows.push(...githubRows(slug, spec.name));
    } catch (e) {
      notes.push(`${spec.name}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  const cache = { at: now, rows, notes };
  writeWorklist(cache);
  return cache;
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

  const refresh = () => {
    if (busy) return;
    busy = true;
    message = "refreshing…";
    draw();
    // gh calls are synchronous; let the "refreshing" frame paint first
    setTimeout(() => {
      try {
        cache = refreshWorklist();
        message = "";
      } catch (e) {
        message = `error: ${(e as Error).message.split("\n")[0]}`;
      }
      busy = false;
      draw();
    }, 10);
  };

  const quit = () => {
    process.stdout.write(LEAVE_SCREEN);
    process.stdin.setRawMode?.(false);
    process.exit(0);
  };

  process.stdout.write(ENTER_SCREEN);
  process.stdin.setRawMode?.(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (data: string) => {
    for (const input of decodeInput(data)) {
      if (input.kind !== "key") continue;
      const list = ranked();
      if (input.key === "q" || input.key === "ctrl-c") quit();
      else if (input.key === "j" || input.key === "down") selected = Math.min(list.length - 1, selected + 1);
      else if (input.key === "k" || input.key === "up") selected = Math.max(0, selected - 1);
      else if (input.key === "r") refresh();
      else if (input.key === "s" && list[selected]) {
        const item = list[selected]!;
        message = `starting ${item.key}…`;
        draw();
        const footer = await runStart(item.repo, item.id);
        message = footer.kind === FooterKind.Error ? `error: ${footer.message}` : `started ${item.key}`;
      }
    }
    draw();
  });
  process.stdout.on("resize", draw);
  setInterval(() => {
    if (Date.now() - cache.at >= WORKLIST_REFRESH_MS) refresh();
  }, 1000);
  setInterval(() => {
    cache = readWorklist().at > cache.at ? readWorklist() : cache;
    draw();
  }, 5000);
  draw();
  if (cache.at === 0) refresh();
  await new Promise(() => {});
}
