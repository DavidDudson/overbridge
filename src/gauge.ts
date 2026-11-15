import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { metaDir } from "./paths";
import { type TurnSummary, turnPath } from "./agent-state";
import { duration } from "./history-report";

/** Per-card context gauge and last-turn receipt, both read through `cachedRead`: the formats are in the README. */

/** A context reading older than this is not shown. */
export const CONTEXT_STALE_MS = 10 * 60_000;
/** A compaction this recent shows the marker. */
export const COMPACT_SHOWN_MS = 30 * 60_000;
const GAUGE_CELLS = 5;

export const contextPath = (meta: string, ws: string) => join(meta, "context", `${ws}.json`);

const cache = new Map<string, { mtimeMs: number; value: unknown }>();

/** `parse` of the file at `path`, re-read only when its mtime changed; undefined when it is missing or unreadable. */
export function cachedRead<T>(path: string, parse: (raw: unknown) => T | undefined): T | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    cache.delete(path);
    return undefined;
  }
  const hit = cache.get(path);
  if (hit?.mtimeMs === mtimeMs) return hit.value as T | undefined;
  let value: T | undefined;
  try {
    value = parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    value = undefined;
  }
  cache.set(path, { mtimeMs, value });
  return value;
}

/** What a busy card shows about the context window. */
export interface Gauge {
  pct: number;
  /** It was compacted not long ago. */
  compacted: boolean;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const parseContext = (raw: unknown): { at: number; pct: number } | undefined => {
  const r = raw as { at?: unknown; pct?: unknown } | null;
  const at = num(r?.at);
  const pct = num(r?.pct);
  return at === undefined || pct === undefined ? undefined : { at, pct: Math.min(100, Math.max(0, Math.round(pct))) };
};

const TURN_KEYS = ["startedAt", "endedAt", "edits", "errors", "compactedAt"] as const;

const parseTurn = (raw: unknown): TurnSummary => {
  const r = (raw ?? {}) as Record<string, unknown>;
  return Object.fromEntries(TURN_KEYS.flatMap((k) => (num(r[k]) === undefined ? [] : [[k, r[k]]])));
};

/** The turn summary of `ws`, if the hook has written one. */
export const readTurn = (ws: string, meta = metaDir()): TurnSummary | undefined => cachedRead(turnPath(meta, ws), parseTurn);

/** `ws`'s context gauge, or undefined without a fresh reading. */
export function readGauge(ws: string, now = Date.now(), meta = metaDir()): Gauge | undefined {
  const ctx = cachedRead(contextPath(meta, ws), parseContext);
  if (!ctx || now - ctx.at > CONTEXT_STALE_MS) return undefined;
  const at = readTurn(ws, meta)?.compactedAt;
  return { pct: ctx.pct, compacted: at !== undefined && now - at < COMPACT_SHOWN_MS };
}

/** `▕███░░▏62%`, with a trailing ` ↻` after a compaction. */
export function gaugeText(g: Gauge): string {
  const filled = Math.round((g.pct / 100) * GAUGE_CELLS);
  return `▕${"█".repeat(filled)}${"░".repeat(GAUGE_CELLS - filled)}▏${g.pct}%${g.compacted ? " ↻" : ""}`;
}

/** What a finished turn did, for the selected card. */
export interface Receipt {
  ms: number;
  edits: number;
  errors: number;
}

/** `ws`'s last finished turn; undefined while none has finished since the last prompt. */
export function readReceipt(ws: string, meta = metaDir()): Receipt | undefined {
  const t = readTurn(ws, meta);
  if (t?.startedAt === undefined || t.endedAt === undefined || t.endedAt < t.startedAt) return undefined;
  return { ms: t.endedAt - t.startedAt, edits: t.edits ?? 0, errors: t.errors ?? 0 };
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `last turn 2m14s · 3 edits · 1 error`; a count of zero is left out. */
export function receiptText(r: Receipt): string {
  return ["last turn " + duration(r.ms), ...(r.edits ? [count(r.edits, "edit")] : []), ...(r.errors ? [count(r.errors, "error")] : [])].join(" · ");
}
