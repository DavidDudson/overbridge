import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { SidebarLayout } from "./config";
import { historyFile } from "./history";
import type { Entry } from "./sidebar";
import type { PrStatus } from "./top";
import { dim, fit, textWidth } from "./term";

/** Panes narrower than this draw compact cards under the `auto` layout. */
export const COMPACT_BELOW = 36;

/** Whether a pane `width` columns wide draws compact cards under `setting`. */
export const isCompact = (setting: SidebarLayout, width: number): boolean => setting === "compact" || (setting === "auto" && width < COMPACT_BELOW);

/** One recent tool call. */
export interface ToolCall {
  label: string;
  at: number;
}

/** How the cards are drawn: compact drops stack lines and the status row; `expanded` is the one card shown in full. */
export interface CardView {
  compact?: boolean;
  expanded?: { tab: string; tools: ToolCall[]; now: number };
}

/** The card's extra lines hold something to act on, so even a compact card keeps its status row. */
const loud = (e: Entry): boolean => Boolean(e.fault || e.error || e.blocked || e.unsaved);

/** Which optional rows `e`'s card shows under `view`. */
export const cardPlan = (e: Entry, view: CardView): { status: boolean; stacks: boolean } => ({
  status: !view.compact || loud(e),
  stacks: !view.compact,
});

export const isExpanded = (e: Entry, view: CardView): boolean => view.expanded?.tab === e.tab;

const CI_TEXT: Partial<Record<PrStatus, string>> = { failing: "failing", pending: "running", mergeable: "passing", merged: "passing" };

/** The PR and CI rows of an expanded card: one per PR, then the CI state of the first, then the last tool calls. */
export function detailRows(e: Entry, tools: readonly ToolCall[], now: number): string[] {
  const prs = (e.prs ?? []).map((p) => `PR #${p.number} · ${p.status}`);
  const first = e.prs?.[0]?.status;
  const ci = first ? [`CI ${CI_TEXT[first] ?? first}`] : [];
  const calls = tools.length ? ["last tools:", ...tools.map((t) => `  ${t.label} ${ago(now - t.at)}`)] : ["no tool calls yet"];
  return [...(prs.length ? prs : ["no PR yet"]), ...ci, ...calls];
}

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};

/** The legend row for the selected entry: what it can do now, then the usual keys. `base` is the plain legend. */
export function contextLegend(e: Entry | undefined, base: string, expanded: boolean, pending = ""): string {
  if (pending) return base;
  if (expanded) return `␣ close  ${base}`;
  if (e && loud(e)) return `⚠ blocked  ${base}`;
  if (e?.prs?.some((p) => p.status === "mergeable")) return `✓ mergeable  ${base}`;
  return e ? `${base}  ␣ more` : base;
}

const PROMPT_HINT = "⏎ go  esc cancel";

/** The prompt row `typed` with a dim key hint after it when both fit in `inner` columns; undefined when they do not. */
export function promptWithHint(typed: string, inner: number): string | undefined {
  const used = textWidth(typed) + 2;
  return used + textWidth(PROMPT_HINT) <= inner ? fit(typed, used) + dim(PROMPT_HINT) + " ".repeat(inner - used - textWidth(PROMPT_HINT)) : undefined;
}

/** How much of a history file's end is read for the last few tool calls. */
const TAIL_BYTES = 16 * 1024;

/** The last `n` tool calls in history `text`, newest first. A `PreToolUse` record is one call. */
export function lastToolCalls(text: string, n: number): ToolCall[] {
  const calls: ToolCall[] = [];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && calls.length < n; i--) {
    try {
      const r = JSON.parse(lines[i]!) as { kind?: string; event?: string; tool?: string; cls?: string; at?: number };
      if (r.kind === "claude" && r.event === "PreToolUse" && r.tool && typeof r.at === "number") {
        calls.push({ label: r.cls && r.cls !== "other" ? `${r.tool}:${r.cls}` : r.tool, at: r.at });
      }
    } catch {
      // a half-written or cut line
    }
  }
  return calls;
}

const toolCache = new Map<string, { mtimeMs: number; size: number; calls: ToolCall[] }>();

/** `ws`'s last `n` tool calls from the end of its history file: one stat per call, a read only when the file changed. */
export function recentTools(ws: string, n = 3, file = historyFile(ws)): ToolCall[] {
  try {
    const { mtimeMs, size } = statSync(file);
    const hit = toolCache.get(file);
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.calls;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buf, 0, len, size - len);
    } finally {
      closeSync(fd);
    }
    const text = buf.toString("utf8");
    const calls = lastToolCalls(size > len ? text.slice(text.indexOf("\n") + 1) : text, n);
    toolCache.set(file, { mtimeMs, size, calls });
    return calls;
  } catch {
    return [];
  }
}
