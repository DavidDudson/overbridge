import type { SortMode } from "./sort-mode";
import type { SidebarLayout } from "./config";
import type { ToolCall } from "./history-tail";
import type { Entry } from "./sidebar";
import type { PrStatus } from "./top";
import { dim, fit, textWidth } from "./term";

/** Panes narrower than this draw compact cards under the `auto` layout. */
export const COMPACT_BELOW = 36;

/** Whether a pane `width` columns wide draws compact cards under `setting`. */
export const isCompact = (setting: SidebarLayout, width: number): boolean => setting === "compact" || (setting === "auto" && width < COMPACT_BELOW);

/** How the cards are drawn: compact drops stack lines and the status row; `expanded` is the one card shown in full. */
export interface CardView {
  compact?: boolean;
  expanded?: { tab: string; toolCalls: ToolCall[] | undefined; now: number };
  /** How the workspaces are ordered, shown in the Workspaces title. */
  sort?: SortMode;
}

/** The card's extra lines hold something to act on, so even a compact card keeps its status row. */
export const needsAttention = (e: Entry): boolean => Boolean(e.fault || e.error || e.blocked || e.unsaved);

/** What needs attention on `e`, in a word. */
const attentionWord = (e: Entry): string => (e.fault ? "fault" : e.error ? "cleanup failed" : e.blocked ? "blocked" : "unsaved");

/** Which optional rows `e`'s card shows under `view`. */
export interface CardPlan {
  status: boolean;
  stacks: boolean;
}

export const cardPlan = (e: Entry, view: CardView): CardPlan => ({
  status: !view.compact || needsAttention(e),
  stacks: !view.compact,
});

export const isExpanded = (e: Entry, view: CardView): boolean => view.expanded?.tab === e.tab;

const CI_RANK: Partial<Record<PrStatus, { rank: number; text: string }>> = {
  failing: { rank: 3, text: "failing" },
  pending: { rank: 2, text: "running" },
  mergeable: { rank: 1, text: "passing" },
  merged: { rank: 1, text: "passing" },
};

/** The CI row of an expanded card: the worst state across its PRs; none when no PR has a CI state (draft, conflict, unknown). */
const ciRow = (prs: readonly { status: PrStatus }[]): string[] => {
  const worst = prs.flatMap((p) => CI_RANK[p.status] ?? []).sort((a, b) => b.rank - a.rank)[0];

  return worst ? [`CI ${worst.text}`] : [];
};

/** The PR and CI rows of an expanded card: one per PR, then the worst CI state, then the last tool calls. */
export function detailRows(e: Entry, toolCalls: readonly ToolCall[] | undefined, now: number): string[] {
  const prs = (e.prs ?? []).map((p) => `PR #${p.number} · ${p.status}`);
  const calls = toolCalls === undefined ? ["tool calls unreadable"] : toolCalls.length ? ["last tools:", ...toolCalls.map((t) => `  ${t.label} ${ago(now - t.at)}`)] : ["no tool calls yet"];

  return [...(prs.length ? prs : ["no PR yet"]), ...ciRow(e.prs ?? []), ...calls];
}

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));

  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};

/** The legend row for the selected entry: what it can do now, then the usual keys. `base` is the plain legend, which alone shows while a digit is held. */
export function contextLegend(e: Entry | undefined, base: string, expanded: boolean): string {
  if (expanded) return `␣ close  ${base}`;

  if (e && needsAttention(e)) return `⚠ ${attentionWord(e)}  ${base}`;

  if (e?.prs?.some((p) => p.status === "mergeable")) return `✓ mergeable  ${base}`;

  return e ? `${base}  ␣ more` : base;
}

const PROMPT_HINT = "⏎ go  esc cancel";

/** The prompt row `typed` with a dim key hint after it when both fit in `inner` columns; undefined when they do not. */
export function promptWithHint(typed: string, inner: number): string | undefined {
  const used = textWidth(typed) + 2;

  return used + textWidth(PROMPT_HINT) <= inner ? fit(typed, used) + dim(PROMPT_HINT) + " ".repeat(inner - used - textWidth(PROMPT_HINT)) : undefined;
}

/**
 * The card view for a pane `width` columns wide. Tool calls are read (through `readCalls`) only while `self`'s card is
 * expanded; a read that fails shows as unreadable on the card instead of ending the pane.
 */
export function viewFor(setting: SidebarLayout, width: number, expandedTab: string | undefined, readCalls: (tab: string) => ToolCall[], now = Date.now()): CardView {
  if (expandedTab === undefined) return { compact: isCompact(setting, width) };
  let toolCalls: ToolCall[] | undefined;

  try {
    toolCalls = readCalls(expandedTab);
  } catch {
    toolCalls = undefined;
  }

  return { compact: isCompact(setting, width), expanded: { tab: expandedTab, toolCalls, now } };
}
