import { type QueueView, type Ticket, ticketKey, ticketName } from "./check-queue";
import { type Move, movedIndex, type QueueOverrides, spreadKeys } from "./check-priority";
import { bold, boxBottom, boxRow, boxTop, cell, colorize, dim, fit, inverse, stripControl, textWidth } from "./term";

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

const EMPTY = "no checks queued; `overbridge check <repo> -- <cmd>` queues one";
const LEGEND = "j/k select   K/J move   t top   b bottom   q quit";

/** Rows the frame takes beyond the list: top border, header, footer, bottom border. */
export const CHECKS_CHROME = 4;

const ICON_COLUMNS = 2;
const WS_COLUMNS = 24;
const REPO_COLUMNS = 14;
const STATE_COLUMNS = 9;

const elapsed = (ms: number) => {
  const secs = Math.max(0, Math.round(ms / 1000));

  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`;
};

export interface ChecksView {
  selected: number;
  offset: number;
  height: number;
  width: number;
  message: string;
  now: number;
}

const iconCell = (icon: string | undefined) => {
  const clean = stripControl(icon ?? "");

  return textWidth(clean) <= ICON_COLUMNS ? cell(clean, ICON_COLUMNS) : fit(clean, ICON_COLUMNS);
};

const rowText = (r: CheckRow, now: number) => {
  const t = r.ticket;
  const state = r.running ? `▶ ${elapsed(now - (t.runningSinceMs ?? now))}` : `⧗ ${elapsed(now - t.queuedAtMs)}`;

  return `${iconCell(t.icon)} ${cell(t.ws.slice(0, WS_COLUMNS), WS_COLUMNS)} ${cell(t.repo.slice(0, REPO_COLUMNS), REPO_COLUMNS)} ${cell(state, STATE_COLUMNS)} ${stripControl(t.command)}`;
};

/** The @checks panel as screen rows. Pure, so it is snapshot-tested. */
export function renderChecks(rows: readonly CheckRow[], { selected, offset, height, width, message, now }: ChecksView): string[] {
  const inner = width - 4;
  const body = Math.max(1, height - CHECKS_CHROME);
  const head = `${cell("", ICON_COLUMNS)} ${cell("workspace", WS_COLUMNS)} ${cell("repo", REPO_COLUMNS)} ${cell("state", STATE_COLUMNS)} command`;
  const visible = rows.slice(offset, offset + body);

  const lines = visible.map((r, i) => {
    const text = fit(rowText(r, now), inner);

    return boxRow(offset + i === selected ? inverse(text) : r.running ? colorize(text, "blue") : text);
  });

  const padding = Array.from({ length: body - visible.length }, (_, i) => boxRow(rows.length === 0 && i === 0 ? dim(fit(EMPTY, inner)) : fit("", inner)));
  const footer = message.startsWith("error: ") ? colorize(fit(message, inner), "red") : message ? bold(fit(message, inner)) : dim(fit(LEGEND, inner));
  const running = rows.filter((r) => r.running).length;

  return [boxTop("Check queue", width), boxRow(dim(fit(head, inner))), ...lines, ...padding, boxRow(footer), boxBottom(width, `${running} running · ${rows.length - running} waiting`, "blue")];
}
