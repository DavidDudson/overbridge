/**
 * Spike prototype for the project-management panel (issue #108; write-up in docs/spikes/project-mgmt-panel.md).
 *
 * A provider-neutral board model and the pure rules over it: which items are ready, which belong to the same
 * workstream, a deterministic ranking, and what to recommend for free slots. No network, no state, no LLM: every
 * decision carries the facts it was made from, so the panel can show *why* a row sits where it does.
 */

import { boxBottom, boxRow, boxTop, fit, inverse, textWidth } from "../term";
import { naturalSort } from "../util";

/** A board column or status, normalised across providers. */
export const BoardStatus = { Backlog: "backlog", Ready: "ready", InProgress: "in-progress", InReview: "in-review", Done: "done", Unknown: "unknown" } as const;
export type BoardStatus = (typeof BoardStatus)[keyof typeof BoardStatus];

/** An item as the board knows it: `WorkItem` plus what the rules need. A provider's `board()` would return these. */
export interface BoardItem {
  id: string;
  title: string;
  url: string;
  status: BoardStatus;
  /** The column or status as the board names it (`In progress`, `Selected for Development`), for display. */
  rawStatus?: string;
  /** 0 is the most urgent (`p0`, Jira `Highest`); unset means none set. */
  priority?: number;
  /** Relative size, 1 (XS) to 5 (XL), or story points; unset means unsized. */
  size?: number;
  labels: string[];
  /** Ids of items that must finish first (GitHub `blockedBy`, Jira `is blocked by` links). */
  blockedBy: string[];
  /** The parent item (an epic), when any. */
  parent?: string;
  /** The board's own ordering, when it has one (a Projects v2 number field, Jira rank). */
  order?: number;
  /** ISO dates. */
  dueAt?: string;
  createdAt: string;
}

export interface BoardOptions {
  /** A label that marks an item blocked by something the board can't link. */
  blockedLabels?: readonly string[];
  /** Label prefixes that name a workstream, e.g. `area:`: items sharing one are the same stream. */
  streamLabelPrefixes?: readonly string[];
}

const DEFAULTS: Required<BoardOptions> = { blockedLabels: ["blocked"], streamLabelPrefixes: ["area:"] };

/**
 * A raw column name as a `BoardStatus`: `map` (from config) first, then common names. Unknown names stay
 * `unknown` rather than guessing, so a misconfigured board shows up instead of silently ranking wrong.
 */
export function normalizeStatus(raw: string | undefined, map: Record<string, BoardStatus> = {}): BoardStatus {
  if (raw === undefined) return BoardStatus.Unknown;
  const mapped = map[raw] ?? Object.entries(map).find(([k]) => k.toLowerCase() === raw.toLowerCase())?.[1];
  if (mapped) return mapped;
  const s = raw.toLowerCase();
  if (/progress|doing|wip|development/.test(s)) return BoardStatus.InProgress;
  if (/review|qa|testing|verify/.test(s)) return BoardStatus.InReview;
  if (/done|closed|complete|released/.test(s)) return BoardStatus.Done;
  if (/ready|to ?do|selected|next/.test(s)) return BoardStatus.Ready;
  if (/backlog|icebox|new|open|triage/.test(s)) return BoardStatus.Backlog;
  return BoardStatus.Unknown;
}

/** Whether an item can be started now. */
export const Readiness = { Ready: "ready", Active: "active", Blocked: "blocked", Done: "done" } as const;
export type Readiness = (typeof Readiness)[keyof typeof Readiness];

export interface Verdict {
  readiness: Readiness;
  /** The facts the verdict rests on, in the order they were checked. */
  because: string[];
}

/**
 * Done items are done; in-progress and in-review ones are active (someone has them); a blocked label or any open
 * blocker blocks. A blocker the board didn't return is assumed open: an unseen item can't be known to be finished.
 */
export function readiness(item: BoardItem, byId: ReadonlyMap<string, BoardItem>, opts: BoardOptions = {}): Verdict {
  const { blockedLabels } = { ...DEFAULTS, ...opts };
  const because: string[] = [];
  if (item.status === BoardStatus.Done) return { readiness: Readiness.Done, because: ["status done"] };
  if (item.status === BoardStatus.InProgress || item.status === BoardStatus.InReview) {
    return { readiness: Readiness.Active, because: [`status ${item.rawStatus ?? item.status}`] };
  }
  const label = item.labels.find((l) => blockedLabels.some((b) => b.toLowerCase() === l.toLowerCase()));
  if (label) because.push(`label ${label}`);
  for (const id of item.blockedBy) {
    const blocker = byId.get(id);
    if (!blocker) because.push(`blocked by ${id} (not on the board, assumed open)`);
    else if (blocker.status !== BoardStatus.Done) because.push(`blocked by ${id} (${blocker.rawStatus ?? blocker.status})`);
  }
  return because.length ? { readiness: Readiness.Blocked, because } : { readiness: Readiness.Ready, because: ["no open blockers"] };
}

/**
 * Workstreams: items joined by a dependency edge or a shared stream label are one stream; the rest stand alone.
 * Two items in different streams can run in parallel without one waiting on, or colliding with, the other.
 * A stream is named by its label when it has one, else by its lowest id, so names are stable across refreshes.
 */
export function streams(items: readonly BoardItem[], opts: BoardOptions = {}): Map<string, string> {
  const { streamLabelPrefixes } = { ...DEFAULTS, ...opts };
  const ids = items.map((i) => i.id);
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    const p = parent.get(id) ?? id;
    if (p === id) return id;
    const r = find(p);
    parent.set(id, r);
    return r;
  };
  const union = (a: string, b: string) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra, rb);
  };
  const streamLabel = (i: BoardItem) => i.labels.find((l) => streamLabelPrefixes.some((p) => l.toLowerCase().startsWith(p.toLowerCase())));
  const byLabel = new Map<string, string>();
  for (const i of items) {
    for (const b of i.blockedBy) union(i.id, b);
    const label = streamLabel(i);
    if (label) {
      const first = byLabel.get(label.toLowerCase());
      first === undefined ? byLabel.set(label.toLowerCase(), i.id) : union(i.id, first);
    }
  }
  // name each component by its label, else its lowest id
  const members = new Map<string, BoardItem[]>();
  for (const i of items) {
    const root = find(i.id);
    members.set(root, [...(members.get(root) ?? []), i]);
  }
  const out = new Map<string, string>();
  for (const group of members.values()) {
    const label = group.map(streamLabel).find((l) => l !== undefined);
    const name = label?.toLowerCase() ?? `#${group.map((i) => i.id).sort(naturalSort)[0]}`;
    for (const i of group) out.set(i.id, name);
  }
  return out;
}

export interface Ranked {
  item: BoardItem;
  readiness: Readiness;
  because: string[];
  stream: string;
  /** Open items waiting on this one. */
  unblocks: number;
  /** 1-based position. */
  rank: number;
}

/** One ordering rule: a sort key per item, smaller first. `text` says what the key means, for `explain`. */
export interface Rule {
  name: string;
  key: (r: Omit<Ranked, "rank">) => number | string;
  text: (r: Omit<Ranked, "rank">) => string;
}

const READINESS_ORDER: Record<Readiness, number> = { ready: 0, active: 1, blocked: 2, done: 3 };
const last = (n: number | undefined) => n ?? Number.MAX_SAFE_INTEGER;
const date = (iso: string | undefined) => (iso === undefined ? Number.MAX_SAFE_INTEGER : Date.parse(iso));

/**
 * The ranking, applied in order; the first rule that tells two items apart decides. The last rule is the id, so
 * no two items ever tie: the order is total, and a sort reaches it from any input order.
 */
export const RULES: readonly Rule[] = [
  { name: "ready, then active, then blocked", key: (r) => READINESS_ORDER[r.readiness], text: (r) => r.readiness },
  { name: "priority, p0 first, unset last", key: (r) => last(r.item.priority), text: (r) => (r.item.priority === undefined ? "no priority" : `p${r.item.priority}`) },
  { name: "unblocks the most open items", key: (r) => -r.unblocks, text: (r) => `unblocks ${r.unblocks}` },
  { name: "due soonest, none last", key: (r) => date(r.item.dueAt), text: (r) => (r.item.dueAt ? `due ${r.item.dueAt.slice(0, 10)}` : "no due date") },
  { name: "board order, unset last", key: (r) => last(r.item.order), text: (r) => (r.item.order === undefined ? "no board order" : `order ${r.item.order}`) },
  { name: "smallest first, unsized last", key: (r) => last(r.item.size), text: (r) => (r.item.size === undefined ? "unsized" : `size ${r.item.size}`) },
  { name: "oldest first", key: (r) => date(r.item.createdAt), text: (r) => `created ${r.item.createdAt.slice(0, 10)}` },
  { name: "id", key: (r) => r.item.id, text: (r) => r.item.id },
];

const compareKeys = (a: number | string, b: number | string) => (typeof a === "string" && typeof b === "string" ? naturalSort(a, b) : a < b ? -1 : a > b ? 1 : 0);

/** The index of the first rule that orders `a` and `b`, and its sign; the id rule always decides at the latest. */
function decide(a: Omit<Ranked, "rank">, b: Omit<Ranked, "rank">): { rule: number; sign: number } {
  for (const [i, rule] of RULES.entries()) {
    const sign = compareKeys(rule.key(a), rule.key(b));
    if (sign !== 0) return { rule: i, sign };
  }
  return { rule: RULES.length - 1, sign: 0 };
}

/** Everything on the board except done items, ranked by `RULES`. Pure: the same items give the same list. */
export function rank(items: readonly BoardItem[], opts: BoardOptions = {}): Ranked[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const open = items.filter((i) => i.status !== BoardStatus.Done);
  const stream = streams(open, opts);
  const unblocks = new Map<string, number>();
  for (const i of open) for (const b of i.blockedBy) unblocks.set(b, (unblocks.get(b) ?? 0) + 1);
  const rows = open.map((item): Omit<Ranked, "rank"> => ({ item, ...readiness(item, byId, opts), stream: stream.get(item.id)!, unblocks: unblocks.get(item.id) ?? 0 }));
  return rows.sort((a, b) => decide(a, b).sign).map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Why `a` ranks where it does against `b`: the deciding rule and both sides' facts. */
export function explain(a: Ranked, b: Ranked): string {
  const { rule, sign } = decide(a, b);
  const r = RULES[rule]!;
  const [above, below] = sign <= 0 ? [a, b] : [b, a];
  return `${above.item.id} above ${below.item.id}: ${r.name} (${r.text(above)} vs ${r.text(below)})`;
}

export interface Recommendation {
  item: BoardItem;
  stream: string;
  why: string[];
}

/**
 * What to start in `freeSlots` slots: the top ready items, at most one per stream, and streams with no active
 * item first, so parallel work lands on independent streams. Streams that are already active are offered only
 * when nothing else is left, with a reason saying so.
 */
export function recommend(ranked: readonly Ranked[], freeSlots: number): Recommendation[] {
  const active = new Set(ranked.filter((r) => r.readiness === Readiness.Active).map((r) => r.stream));
  const ready = ranked.filter((r) => r.readiness === Readiness.Ready);
  const out: Recommendation[] = [];
  const taken = new Set<string>();
  const pick = (r: Ranked, note: string) => {
    taken.add(r.stream);
    out.push({ item: r.item, stream: r.stream, why: [`rank ${r.rank}`, ...r.because, note] });
  };
  for (const r of ready) {
    if (out.length >= freeSlots) break;
    if (!taken.has(r.stream) && !active.has(r.stream)) pick(r, `stream ${r.stream} has nothing active`);
  }
  for (const r of ready) {
    if (out.length >= freeSlots) break;
    if (!taken.has(r.stream)) pick(r, `stream ${r.stream} already has active work; may collide`);
  }
  return out;
}

/** A workspace holding an item, as the panel shows it on the row. */
export interface SlotInfo {
  ws: string;
  glyph: string;
}

const READINESS_MARK: Record<Readiness, string> = { ready: "🟢", active: "🔵", blocked: "🔴", done: "⚫" };

/**
 * The panel's rows for a pane `width` wide: a frame titled with the counts, a header, then a row per ranked item
 * (mark, id, priority, size, title, stream, then its workspace or why it waits), the one under `cursor` inverse.
 * A sketch of the k9s-like list; the real thing would also take a filter and scroll.
 */
export function renderBoard(ranked: readonly Ranked[], slots: ReadonlyMap<string, SlotInfo>, cursor: number, width: number, height: number): string[] {
  const inner = Math.max(1, width - 4);
  const count = (r: Readiness) => ranked.filter((x) => x.readiness === r).length;
  const title = `Board · ${count(Readiness.Ready)} ready · ${count(Readiness.Active)} active · ${count(Readiness.Blocked)} blocked`;
  const idWidth = Math.max(2, ...ranked.map((r) => textWidth(r.item.id)));
  const streamWidth = Math.max(6, ...ranked.map((r) => textWidth(r.stream)));
  const left = (text: string, w: number) => fit(text, w);
  const row = (r: Ranked) => {
    const slot = slots.get(r.item.id);
    const tail = slot ? `${slot.glyph} ${slot.ws}` : r.readiness === Readiness.Blocked ? r.because.join(", ") : `unblocks ${r.unblocks}`;
    const pri = r.item.priority === undefined ? "  " : `p${r.item.priority}`;
    const size = r.item.size === undefined ? " " : String(r.item.size);
    const lead = `${READINESS_MARK[r.readiness]} ${left(r.item.id, idWidth)} ${pri} ${size} `;
    const trail = ` ${left(r.stream, streamWidth)} ${tail}`;
    const titleWidth = Math.max(4, inner - textWidth(lead) - textWidth(trail));
    return `${lead}${fit(r.item.title, titleWidth)}${trail}`;
  };
  // the header's columns line up with a row's: mark (2) + space, id, pri (2), size (1), title, stream, tail
  const header = fit(`  ${left("id", idWidth)} pr sz ${left("title", Math.max(4, inner - idWidth - streamWidth - 26))} ${left("stream", streamWidth)} slot / waits on`, inner);
  const bodyRows = Math.max(0, height - 3);
  const body = ranked.slice(0, bodyRows).map((r, i) => (i === cursor ? inverse(fit(row(r), inner)) : fit(row(r), inner)));
  const padded = [...body, ...Array<string>(Math.max(0, bodyRows - body.length)).fill(" ".repeat(inner))];
  return [boxTop(title, width), boxRow(header), ...padded.map(boxRow), boxBottom(width, "⏎ start in a slot · o open · r refresh · / filter · b blocked", "grey")];
}
