import { alternate, spinner } from "./anim";
import { age, type PrRow, type ViewState } from "./pr-rows";
import { silencedTitle } from "./silence";
import { ciLook, conflictLook } from "./pr-look";
import type { PrView } from "./prs-view";
import { Action, Keyset, legendOf } from "./keys";
import { SORT_LABEL, type SortMode } from "./sort-mode";
import { REVIEWER_LOOK, type ReviewerStatus } from "./reviewers";
import { bold, boxBottom, boxRow, boxTop, type Color, colorize, dim, fit, inverse } from "./term";

/** Rows a table spends besides its PR rows: top border, header, bottom border. */
const TABLE_CHROME = 3;

/** The one footer row under both tables. */
const FOOTER_ROWS = 1;

/** How the reviews are ordered until the user cycles it: what needs doing first. */
export const DEFAULT_REVIEWS_SORT: SortMode = "status";

export type Group = "direct" | "team";

const GROUPS: Record<Group, { title: string; empty: string; unit: string }> = {
  direct: { title: "Asked of me", empty: "nothing asked of you directly", unit: "direct" },
  team: { title: "Asked of my teams", empty: "nothing asked of your teams", unit: "via teams" },
};

const groupOf = (r: PrRow): Group => r.group ?? "direct";

/** The rows split into the two tables, each keeping the order of `rows`. */
export const split = (rows: readonly PrRow[]): Record<Group, PrRow[]> => ({ direct: rows.filter((r) => groupOf(r) === "direct"), team: rows.filter((r) => groupOf(r) === "team") });

/** Cursor order: the direct table, then the team table. */
const order = (rows: readonly PrRow[]): readonly PrRow[] => {
  const { direct, team } = split(rows);

  return [...direct, ...team];
};

type Key = "merge" | "repo" | "num" | "ci" | "copilot" | "rabbit" | "via" | "author" | "age";

interface Column {
  key: Key;
  title: string;
  width: number;
  /** When the title would be too narrow, columns with a drop order go, lowest first. */
  drop?: number;
}

/** Both tables use these, so every column lines up from one table to the next. */
const COLUMNS: readonly Column[] = [
  { key: "merge", title: "merge", width: 11 },
  { key: "repo", title: "repo", width: 18 },
  { key: "num", title: "#", width: 5 },
  { key: "ci", title: "ci", width: 3 },
  { key: "copilot", title: "copilot", width: 7 },
  { key: "rabbit", title: "rabbit", width: 7 },
  { key: "via", title: "asked via", width: 14, drop: 2 },
  { key: "author", title: "author", width: 10, drop: 1 },
  { key: "age", title: "age", width: 4, drop: 3 },
];

const MIN_TITLE = 16;

/** The columns that fit in `inner` columns while leaving the title `MIN_TITLE`. */
export function columnsFor(inner: number): Column[] {
  const used = (cols: Column[]) => cols.reduce((n, c) => n + c.width + 1, 0);
  let cols = [...COLUMNS];

  while (inner - used(cols) < MIN_TITLE) {
    const next = cols.filter((c) => c.drop !== undefined).toSorted((a, b) => a.drop! - b.drop!)[0];

    if (!next) break;
    cols = cols.filter((c) => c !== next);
  }

  return cols;
}

interface Cell {
  text: string;
  color?: Color;
}

const ageColor = (iso: string, now: number): Color => {
  const days = (now - Date.parse(iso)) / 86_400_000;

  return !Number.isFinite(days) || days < 1 ? "green" : days < 3 ? "yellow" : "red";
};

const botCell = (bots: readonly ReviewerStatus[] | undefined, name: ReviewerStatus["name"], now: number, animated: boolean): Cell => {
  const b = bots?.find((x) => x.name === name);

  if (!b) return { text: name === "CodeRabbit" ? "" : "⚪", color: "grey" };
  const look = REVIEWER_LOOK[b.state];
  const text = `${look.icon}${b.detail ? ` ${b.detail}` : ""}`;

  return { text: b.state === "reviewing" && animated ? `${spinner(now)} ${b.detail ?? ""}`.trim() : text, color: look.color };
};

/** What each column of `r` shows. A conflict pulses between two glyphs of one width when `animated`. */
export function cellsFor(r: PrRow, now: number, animated: boolean): Record<Key, Cell> {
  const merge = conflictLook(r.mergeable);
  const conflict = r.mergeable === "CONFLICTING";
  const ci = ciLook(r.ci);

  return {
    merge: { text: `${conflict && animated ? alternate("💥", "🔥", now) : merge.icon} ${conflict ? "conflict" : merge.label}`.slice(0, 11), color: merge.color },
    repo: { text: r.repo, color: "cyan" },
    num: { text: String(r.number), color: "grey" },
    ci: { text: r.ci === "pending" && animated ? spinner(now) : ci.icon, color: ci.color },
    copilot: botCell(r.bots, "Copilot", now, animated),
    rabbit: botCell(r.bots, "CodeRabbit", now, animated),
    via: group(r) === "team" ? { text: teamNames(r.via), color: "yellow" } : { text: "you", color: "green" },
    author: { text: r.author, color: "purple" },
    age: { text: age(r.updatedAt, now), color: ageColor(r.updatedAt, now) },
  };
}

const group = groupOf;

/** `org/core, org/infra` as `core, infra`: the filter keeps one owner, so the org is noise. */
export const teamNames = (via: string | undefined): string => (via ? via.split(", ").map((t) => t.split("/").pop()).join(", ") : "team");

const hasMotion = (r: PrRow) => r.mergeable === "CONFLICTING" || r.ci === "pending" || (r.bots ?? []).some((b) => b.state === "reviewing");

/** A fitted piece of a row; no colour is the default text. */
interface Part {
  text: string;
  color?: Color | undefined;
}

/** One table row: coloured cells, or plain text in inverse when selected. A draft or a silenced row is dim. */
export function rowText(r: PrRow, cols: readonly Column[], inner: number, selected: boolean, now: number, animated: boolean, silenced = false): string {
  const cells = cellsFor(r, now, animated);
  const titleWidth = Math.max(1, inner - cols.reduce((n, c) => n + c.width + 1, 0));
  const parts: Part[] = [...cols.map((c) => ({ text: fit(cells[c.key].text, c.width), color: cells[c.key].color })), { text: fit(silencedTitle(r.title, silenced), titleWidth) }];

  if (selected) return inverse(parts.map((p) => p.text).join(" "));
  const style = (p: Part) => (r.draft || silenced ? dim(p.color ? colorize(p.text, p.color) : p.text) : p.color ? colorize(p.text, p.color) : p.text);

  return parts.map(style).join(" ");
}

const headerText = (cols: readonly Column[], inner: number) =>
  dim(fit([...cols.map((c) => c.title.padEnd(c.width)), "title"].join(" "), inner));

/**
 * How many PR rows each table gets out of `body` rows. Each table shows what it has when both fit; otherwise
 * the shorter one keeps its rows and the other gets the rest, so neither is squeezed out. An empty table keeps one row for its note.
 */
export interface Share {
  direct: number;
  team: number;
}

export function allocate(direct: number, team: number, body: number): Share {
  const need: Share = { direct: Math.max(1, direct), team: Math.max(1, team) };

  if (need.direct + need.team <= body) return need;
  const half = Math.floor(body / 2);
  const d = need.direct <= half ? need.direct : need.team <= body - half ? body - need.team : half;

  return { direct: Math.max(1, d), team: Math.max(1, body - Math.max(1, d)) };
}

/** First row of a window of `rows` rows over `count` that keeps `selected` in view, roughly centred. */
export const windowStart = (count: number, selected: number | undefined, rows: number): number =>
  selected === undefined || count <= rows ? 0 : Math.min(count - rows, Math.max(0, selected - Math.floor(rows / 2)));

const footer = (message: string, inner: number, sort: SortMode) =>
  message.startsWith("error: ") ? colorize(fit(message, inner), "red") : message ? bold(fit(message, inner)) : dim(fit(legendOf(Keyset.reviews, { [Action.Enter]: "", [Action.Sort]: `sort: ${SORT_LABEL[sort]}` }), inner));

/** The Reviews tab as screen rows: two tables, same columns, direct requests above team requests. Pure, so it is snapshot-tested. */
function render(rows: readonly PrRow[], { selected, height, width, message, now, sort = DEFAULT_REVIEWS_SORT, silenced = new Set() }: ViewState): string[] {
  const inner = width - 4;
  const cols = columnsFor(inner);
  const groups = split(rows);
  const body = Math.max(2, height - 2 * TABLE_CHROME - FOOTER_ROWS);
  const share = allocate(groups.direct.length, groups.team.length, body);
  const busy = message.startsWith("refreshing");
  const out: string[] = [];

  for (const g of ["direct", "team"] as const) {
    const list = groups[g];
    const first = g === "direct" ? 0 : groups.direct.length;
    const mine = selected >= first && selected < first + list.length ? selected - first : undefined;
    const rowsHere = share[g];
    const start = windowStart(list.length, mine, rowsHere);
    const title = `${busy ? `${spinner(now)} ` : ""}${GROUPS[g].title} · ${list.length}`;

    out.push(boxTop(title, width), boxRow(headerText(cols, inner)));

    for (let i = 0; i < rowsHere; i++) {
      const r = list[start + i];
      out.push(boxRow(r ? rowText(r, cols, inner, mine === start + i, now, true, silenced.has(r.url)) : list.length === 0 && i === 0 ? dim(fit(GROUPS[g].empty, inner)) : fit("", inner)));
    }

    out.push(boxBottom(width, list.length > rowsHere ? `${start + 1}-${Math.min(list.length, start + rowsHere)} of ${list.length}` : GROUPS[g].unit, g === "direct" ? "cyan" : "yellow"));
  }

  while (out.length < height - FOOTER_ROWS) out.push(fit("", width));
  out.push(footer(message, width, sort));

  return out;
}

export const reviewsView: PrView = { order, render, animated: (rows) => rows.some(hasMotion) };
