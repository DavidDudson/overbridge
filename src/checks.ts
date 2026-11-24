import { Outcome, outcomeOf, type QueueView, type Ticket, ticketKey, ticketName } from "./check-queue";
import { type Move, movedIndex, type QueueOverrides, spreadKeys } from "./check-priority";
import { type EstimateStore, type Eta, etaSlots, formatDuration, lastDoneMs, queueEtas, workspaceDone } from "./check-estimate";
import type { CheckRecord, HistoryStore } from "./history";
import { type BadgeIcon, badgeFromIcons, type TabBadge } from "./tab-badge";
import { bold, boxBottom, type Color, boxRow, boxTop, cell, colorize, dim, fit, inverse, stripControl, textWidth } from "./term";

/** One check as the @checks tab lists it. */
export interface CheckRow {
  ticket: Ticket;
  /** Sort key under the current overrides. */
  key: number;
  running: boolean;
}

/** Running checks first, then the waiting ones in the order they will start; `queue` is already in queue order. */
export const checkRows = (queue: QueueView, overrides: QueueOverrides): CheckRow[] => [
  ...queue.running.map((ticket) => ({ ticket, key: ticketKey(ticket, overrides), running: true })),
  ...queue.waiting.map((ticket) => ({ ticket, key: ticketKey(ticket, overrides), running: false })),
];

/**
 * The overrides after moving `rows[selected]`: the waiting checks take the same keys in their new order, so a move
 * never needs a key between two others. Undefined when the check is running or already there.
 */
export function movedOverrides(rows: readonly CheckRow[], selected: number, move: Move, overrides: QueueOverrides): QueueOverrides | undefined {
  const chosen = rows[selected];

  if (!chosen || chosen.running) {
    return undefined;
  }

  const waiting = rows.filter((r) => !r.running);
  const from = waiting.indexOf(chosen);
  const to = movedIndex(waiting.length, from, move);

  if (to === undefined) {
    return undefined;
  }

  const reordered = waiting.toSpliced(from, 1).toSpliced(to, 0, chosen);
  const keys = spreadKeys(waiting.map((r) => r.key));
  const live = new Set(rows.map((r) => ticketName(r.ticket)));
  const kept = Object.entries(overrides).filter(([name]) => live.has(name));

  return { ...Object.fromEntries(kept), ...Object.fromEntries(reordered.map((r, i) => [ticketName(r.ticket), keys[i] ?? r.key])) };
}

/** What the @checks tab shows: the live queue, or the runs that finished recently. */
export const ChecksMode = { Queue: "queue", Recent: "recent" } as const;

export type ChecksMode = (typeof ChecksMode)[keyof typeof ChecksMode];

export const nextChecksMode = (mode: ChecksMode): ChecksMode => (mode === ChecksMode.Queue ? ChecksMode.Recent : ChecksMode.Queue);

const EMPTY = "no checks queued; `overbridge check <repo> -- <cmd>` queues one";
const LEGEND = "j/k select   K/J move   t top   b bottom   x kill   v recent   q quit";
const RECENT_EMPTY = "no checks finished in this window";
const RECENT_LEGEND = "j/k select   v queue   r reload   q quit";

/** Rows the frame takes beyond the list: top border, header, footer, bottom border. */
export const CHECKS_CHROME = 4;

const ICON_COLUMNS = 2;
const WS_COLUMNS = 24;
const REPO_COLUMNS = 14;
const STATE_COLUMNS = 9;

export { formatDuration };

export interface ChecksView {
  selected: number;
  offset: number;
  height: number;
  width: number;
  message: string;
  now: number;
}

/** The queue view's estimates: each ticket's ETA by `ticketName`, each workspace's done time, and when the queue should be empty. */
export interface QueueEstimates {
  etas: ReadonlyMap<string, Eta>;
  wsDoneMs: ReadonlyMap<string, number>;
  clearMs?: number;
}

const NO_ESTIMATES: QueueEstimates = { etas: new Map(), wsDoneMs: new Map() };

/** Estimates for a live queue from past run times; `maxParallel` caps the lanes when known. */
export function queueEstimates(queue: QueueView, store: EstimateStore, now: number, maxParallel?: number): QueueEstimates {
  const etas = queueEtas(queue, store, etaSlots(queue.running.length, maxParallel), now, ticketName);

  return { etas, wsDoneMs: workspaceDone(queue, etas, ticketName), clearMs: lastDoneMs([...etas.values()].map((eta) => eta.doneMs)) };
}

const EST_COLUMNS = 7;
const ETA_COLUMNS = 13;

/** `~3m05s`, or `?` when the exact command has never finished in its repo. */
const estText = (eta: Eta | undefined) => (eta?.runMs === undefined ? "?" : `~${formatDuration(eta.runMs)}`);

/** A running check's time left, or a waiting one's start; blank when it cannot be known. */
const etaText = (r: CheckRow, eta: Eta | undefined) => {
  if (r.running) {
    if (eta?.doneMs === undefined) {
      return "";
    }

    return eta.doneMs > 0 ? `done ~${formatDuration(eta.doneMs)}` : "overdue";
  }

  return eta?.startMs === undefined ? "" : `start ~${formatDuration(eta.startMs)}`;
};

const iconCell = (icon: string | undefined) => {
  const clean = stripControl(icon ?? "");

  return textWidth(clean) <= ICON_COLUMNS ? cell(clean, ICON_COLUMNS) : fit(clean, ICON_COLUMNS);
};

const rowText = (r: CheckRow, now: number, estimates: QueueEstimates) => {
  const t = r.ticket;
  const state = r.running ? `▶ ${formatDuration(now - (t.runningSinceMs ?? now))}` : `⧗ ${formatDuration(now - t.queuedAtMs)}`;
  const eta = estimates.etas.get(ticketName(t));

  return `${iconCell(t.icon)} ${cell(t.ws.slice(0, WS_COLUMNS), WS_COLUMNS)} ${cell(t.repo.slice(0, REPO_COLUMNS), REPO_COLUMNS)} ${cell(state, STATE_COLUMNS)} ${cell(estText(eta), EST_COLUMNS)} ${cell(etaText(r, eta), ETA_COLUMNS)} ${stripControl(t.command)}`;
};

/** The bottom border's estimate: when the queue as a whole should be empty. */
const queueDoneText = ({ clearMs }: QueueEstimates) => (clearMs !== undefined && clearMs > 0 ? ` · clear ~${formatDuration(clearMs)}` : "");

/** The @checks panel as screen rows. Pure, so it is snapshot-tested. */
export function renderChecks(rows: readonly CheckRow[], { selected, offset, height, width, message, now }: ChecksView, estimates: QueueEstimates = NO_ESTIMATES): string[] {
  const inner = width - 4;
  const body = Math.max(1, height - CHECKS_CHROME);
  const head = `${cell("", ICON_COLUMNS)} ${cell("workspace", WS_COLUMNS)} ${cell("repo", REPO_COLUMNS)} ${cell("state", STATE_COLUMNS)} ${cell("est", EST_COLUMNS)} ${cell("eta", ETA_COLUMNS)} command`;
  const visible = rows.slice(offset, offset + body);

  const lines = visible.map((r, i) => {
    const text = fit(rowText(r, now, estimates), inner);

    return boxRow(offset + i === selected ? inverse(text) : r.running ? colorize(text, "blue") : text);
  });

  const padding = Array.from({ length: body - visible.length }, (_, i) => boxRow(rows.length === 0 && i === 0 ? dim(fit(EMPTY, inner)) : fit("", inner)));
  const footer = message.startsWith("error: ") ? colorize(fit(message, inner), "red") : message ? bold(fit(message, inner)) : dim(fit(LEGEND, inner));
  const running = rows.filter((r) => r.running).length;

  return [boxTop("Check queue", width), boxRow(dim(fit(head, inner))), ...lines, ...padding, boxRow(footer), boxBottom(width, `${running} running · ${rows.length - running} waiting${queueDoneText(estimates)}`, "blue")];
}

/** Identifies a finished run across re-reads, so the cursor can stay on it. */
export const recentKey = (r: RecentCheck) => `${r.ws}@${r.record.at}`;

/** One finished check run, with the workspace whose history holds it. */
export interface RecentCheck {
  ws: string;
  record: CheckRecord;
}

/** How long the recent view looks back. */
export const RECENT_WINDOW_MS = 24 * 60 * 60_000;

/** At most this many runs, newest first. */
export const RECENT_LIMIT = 500;

/** Every check run in `store` that ended at or after `sinceMs`, newest first, at most `limit`. */
export const recentChecks = (store: HistoryStore, sinceMs: number, limit = RECENT_LIMIT): RecentCheck[] =>
  store
    .workspaces()
    .flatMap((ws) => store.read(ws, sinceMs).flatMap((record) => (record.kind === "check" ? [{ ws, record }] : [])))
    .toSorted((a, b) => b.record.at - a.record.at)
    .slice(0, limit);

const OUTCOME_TEXT: Record<Outcome, string> = {
  [Outcome.Passed]: "✓ ok",
  [Outcome.Failed]: "✗ exit",
  [Outcome.TimedOut]: "⏱ timeout",
  [Outcome.Stalled]: "⏸ stalled",
  [Outcome.GaveUp]: "⧗ gave up",
  [Outcome.Killed]: "■ killed",
};

const outcomeText = (record: CheckRecord) => {
  const outcome = outcomeOf(record);

  return outcome === Outcome.Failed ? `${OUTCOME_TEXT[outcome]} ${record.exit}` : OUTCOME_TEXT[outcome];
};

const OUTCOME_COLOR: Record<Outcome, Color> = {
  [Outcome.Passed]: "green",
  [Outcome.Failed]: "red",
  [Outcome.TimedOut]: "red",
  [Outcome.Stalled]: "red",
  [Outcome.GaveUp]: "yellow",
  [Outcome.Killed]: "grey",
};

const AGO_COLUMNS = 10;
const RESULT_COLUMNS = 11;
const TIME_COLUMNS = 7;

const recentText = ({ ws, record }: RecentCheck, now: number) =>
  [
    cell(`${formatDuration(now - record.at)} ago`, AGO_COLUMNS),
    cell(ws.slice(0, WS_COLUMNS), WS_COLUMNS),
    cell(record.repo.slice(0, REPO_COLUMNS), REPO_COLUMNS),
    cell(outcomeText(record), RESULT_COLUMNS),
    cell(formatDuration(record.queuedMs), TIME_COLUMNS),
    cell(record.runMs ? formatDuration(record.runMs) : "-", TIME_COLUMNS),
    stripControl(record.full ?? record.command),
  ].join(" ");

/** Totals for the recent view's bottom border: runs, failures, and the time spent running and waiting. */
export function recentTotals(rows: readonly RecentCheck[]): string {
  const failed = rows.filter((r) => outcomeOf(r.record) !== Outcome.Passed).length;
  const runMs = rows.reduce((sum, r) => sum + r.record.runMs, 0);
  const queuedMs = rows.reduce((sum, r) => sum + r.record.queuedMs, 0);

  return `${rows.length} runs · ${failed} not ok · ran ${formatDuration(runMs)} · waited ${formatDuration(queuedMs)}`;
}

/** The recent view of the @checks panel as screen rows: finished runs, newest first. Pure, so it is snapshot-tested. */
export function renderRecent(rows: readonly RecentCheck[], { selected, offset, height, width, message, now }: ChecksView): string[] {
  const inner = width - 4;
  const body = Math.max(1, height - CHECKS_CHROME);
  const head = [cell("ended", AGO_COLUMNS), cell("workspace", WS_COLUMNS), cell("repo", REPO_COLUMNS), cell("result", RESULT_COLUMNS), cell("wait", TIME_COLUMNS), cell("run", TIME_COLUMNS), "command"].join(" ");
  const visible = rows.slice(offset, offset + body);

  const lines = visible.map((r, i) => {
    const text = fit(recentText(r, now), inner);

    return boxRow(offset + i === selected ? inverse(text) : colorize(text, OUTCOME_COLOR[outcomeOf(r.record)]));
  });

  const padding = Array.from({ length: body - visible.length }, (_, i) => boxRow(rows.length === 0 && i === 0 ? dim(fit(RECENT_EMPTY, inner)) : fit("", inner)));
  const footer = message.startsWith("error: ") ? colorize(fit(message, inner), "red") : message ? bold(fit(message, inner)) : dim(fit(RECENT_LEGEND, inner));

  return [boxTop("Recent checks (24h)", width), boxRow(dim(fit(head, inner))), ...lines, ...padding, boxRow(footer), boxBottom(width, recentTotals(rows), "blue")];
}

export const CHECK_RUNNING_ICON: BadgeIcon = { icon: "🔄", color: "yellow", rank: 0 };

export const CHECK_WAITING_ICON: BadgeIcon = { icon: "⏳", color: "grey", rank: 1 };

/** The @checks card's badge: an icon per running check, then one per waiting check; none when the queue is empty. */
export function checksBadge(queue: QueueView): TabBadge | undefined {
  const icons = [...queue.running.map(() => CHECK_RUNNING_ICON), ...queue.waiting.map(() => CHECK_WAITING_ICON)];

  return icons.length ? badgeFromIcons(icons) : undefined;
}
