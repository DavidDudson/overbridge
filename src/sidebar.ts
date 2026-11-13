import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userLayoutPath } from "./layout";
import { join } from "node:path";
import { ATTENTION, type AgentState, glyphFor, readAgentState, UNKNOWN_GLYPH } from "./agent-state";
import { iceboxHint } from "./icebox-suggest";
import { createReaper, type ReapResult } from "./auto-remove";
import { requireWs } from "./commands";
import { readQueue, type Ticket } from "./check-queue";
import { type CleanupInFlight, cleanupRecords, cleanupRows } from "./cleanup-log";
import { metaDir, selfCommand } from "./paths";
import { type Limits, limitRows, readLimits } from "./limits";
import { next } from "./next";
import { ORCHESTRATION_TABS, orchestrationTab } from "./orchestration";
import { ensureOrchestrationTabs } from "./orchestration-keep";
import { moveWithHistory, readHistory, Travel, travel, visit } from "./sidebar-history";
import { isIceboxed, isRemoving, isWorkspaceState, RemovalBlock, readState, type Removing, type State, tryReadState, watchState, type WorkspaceState, workspaceFault } from "./state";
import { serverOwnsSweep } from "./server-client";
import { claimSweep, createSweepTrigger, startSweep } from "./sweep-trigger";
import { boxBottom, boxDivider, boxRow, boxTop, type Color, colorize, decodeInput, dim, ENTER_SCREEN, fit, frame, type Input, inverse, LEAVE_SCREEN, textWidth } from "./term";
import { readTopCache, readTopCacheChecked, sidebarLabel, type TopCache } from "./top";
import { defaultMux, type Mux } from "./mux";
import { currentTab, tabOrder } from "./tab";
import { createPainter, readView, shouldPoll } from "./zellij-view";
import { errorMessage, naturalSort, run, spawnCwd } from "./util";
import { overbridgeVersion } from "./version";

/** The key that jumps to the performance tab, and the tab it reaches. */
export const PERF_KEY = "p";
export const PERF_TAB = "@perf";

/** How long a held digit waits for a second one before it goes to its one-digit tab. */
export const DIGIT_MS = 600;

/** The key legend: the tab numbers the digits reach for `count` tabs, or the digit held while one waits. */
export function legend(count: number, pending = ""): string {
  if (pending) {
    return `${pending}…`;
  }
  const digits = count > 1 ? `1-${count} go  ` : count === 1 ? "1 go  " : "";
  return `${digits}←→ back  ⌥w next  s new ws  p perf`;
}

/**
 * The vertical tab sidebar. Every tab runs its own copy, which marks its own tab as current.
 * Moving to another tab switches there and focuses that tab's sidebar, so the next keypress
 * keeps stepping.
 */

const POLL_MS = 1_000;

/** The sidebar frame an entry is drawn in. */
export const Section = { Orchestration: "orchestration", Workspaces: "workspaces" } as const;
export type Section = (typeof Section)[keyof typeof Section];

export interface Entry {
  /** The zellij tab name: a workspace, or an orchestration tab such as `@root`. */
  tab: string;
  section: Section;
  /** Agent state glyph. */
  glyph: string;
  state?: AgentState | undefined;
  /** Item id and title when known, else the workspace name. */
  label: string;
  /** Why the last background removal failed; replaces the status line. */
  error?: string;
  /** Why the merged-PR sweep kept this workspace; replaces the agent status line. */
  blocked?: RemovalBlock;
  /** The session ended, but uncommitted or unpushed work keeps the workspace. */
  unsaved?: boolean;
  /** Stacked PRs of this workspace, bottom first, with the claimed one's number; one compact line each. */
  stacks?: { prs: number[]; current: number }[];
  /** This entry could not be read: a bad cache or state record, or a reader that threw. Replaces the status line. */
  fault?: string;
  /** Its draft PRs have sat idle past `icebox.idle-days`: a suggestion to icebox it, never done automatically. */
  idleHint?: string;
}

export { sidebarLabel, stripConventional } from "./top";

export { currentTab, tabOrder };

const entryFor = (tab: string, section: Section, label: string): Entry => {
  const state = readAgentState(tab);
  return { tab, section, glyph: glyphFor(state), state, label };
};

/** A card for an entry that could not be read: its label and why, no agent state. */
const faultEntry = (tab: string, section: Section, fault: string, label = tab): Entry => ({ tab, section, glyph: UNKNOWN_GLYPH, label, fault });

/** `build()`'s entry, or a fault card when it throws, so one bad tab never costs the whole list. */
function guardedEntry(tab: string, section: Section, build: () => Entry, label = tab): Entry {
  try {
    return build();
  } catch (e) {
    return faultEntry(tab, section, errorMessage(e), label);
  }
}

/** The stacks in `cache`: each claimed stacked PR's layers, bottom first. */
const stacksOf = (cache: Pick<TopCache, "links">): NonNullable<Entry["stacks"]> =>
  cache.links.flatMap((l) => (l.pr && l.pr.stack.length > 1 && l.pr.claimed !== false ? [{ prs: l.pr.stack, current: l.pr.number }] : []));

/** `stack 12·[13]·14`: the claimed layer in brackets, layers in order bottom to top. */
const stackText = (s: { prs: number[]; current: number }) => `stack ${s.prs.map((n) => (n === s.current ? `[${n}]` : String(n))).join("·")}`;

/** The card for workspace `ws` whose state record is `w`: a fault card when the record or its top cache is malformed. */
function workspaceEntry(ws: string, w: unknown): Entry {
  const recordFault = workspaceFault(w);
  if (recordFault !== undefined) {
    return faultEntry(ws, Section.Workspaces, recordFault);
  }
  const { removeError: error, removalBlocked: blocked } = w as WorkspaceState;
  const { cache, fault } = readTopCacheChecked(ws);
  const entry = entryFor(ws, Section.Workspaces, sidebarLabel(ws, cache));
  const stacks = stacksOf(cache);
  const idleHint = fault ? undefined : iceboxHint(ws, cache);
  return { ...entry, ...(stacks.length ? { stacks } : {}), ...(fault ? { fault } : {}), ...(error ? { error } : {}), ...(blocked ? { blocked } : {}), ...(idleHint ? { idleHint } : {}) };
}

/** `w` as the record of a workspace being removed right now, else undefined; a malformed record is never one. */
const removingRecord = (w: unknown, now = Date.now()): (WorkspaceState & { removing: Removing }) | undefined =>
  isWorkspaceState(w) && w.removing && isRemoving(w, now) ? (w as WorkspaceState & { removing: Removing }) : undefined;

/** Whether `w` is iceboxed: it has no tab, so it gets no card and no digit. A malformed record is never one. */
const isIced = (workspaces: Record<string, unknown>, ws: string): boolean => {
  try {
    const w = workspaces[ws];
    return isWorkspaceState(w) && isIceboxed(w);
  } catch {
    return false; // a record that throws is a card to show, never one to hide
  }
};

/**
 * Whether `workspaces[ws]` hides its workspace as being removed. Reading the record and checking its worker's pid
 * both happen inside the guard: a record that throws is a card to show, never one to hide.
 */
const hiddenByRemoval = (workspaces: Record<string, unknown>, ws: string): boolean => {
  try {
    return removingRecord(workspaces[ws]) !== undefined;
  } catch {
    return false;
  }
};

/**
 * The orchestration tabs, then every workspace in tab order, so the Alt+digit keys match the digits shown.
 * The generated layout opens the orchestration tabs first, so their digits come first in tab order too.
 * Each card is built on its own: a workspace whose files are bad or whose readers throw gets a fault card.
 */
export function entries(order: string[] = tabOrder(), state: State = readState()): Entry[] {
  const workspaces: Record<string, unknown> = state.workspaces;
  const names = Object.keys(workspaces).filter((ws) => !hiddenByRemoval(workspaces, ws) && !isIced(workspaces, ws)).sort(naturalSort);
  const rank = (ws: string) => { const i = order.indexOf(ws); return i < 0 ? order.length : i; };
  return [
    ...ORCHESTRATION_TABS.map((t) => guardedEntry(t.tab, Section.Orchestration, () => entryFor(t.tab, Section.Orchestration, t.label), t.label)),
    ...names.toSorted((a, b) => rank(a) - rank(b)).map((ws) => guardedEntry(ws, Section.Workspaces, () => workspaceEntry(ws, workspaces[ws]))),
  ];
}

/** How many leading entries sit in the Orchestration frame, which never scrolls. */
export const pinnedCount = (list: Entry[]) => list.filter((e) => e.section === Section.Orchestration).length;

/** Rows the Orchestration frame takes: its two borders and its cards, or none when it is empty. */
export const pinnedRowsFor = (heights: number[], pinned: number) => (pinned ? 2 + heights.slice(0, pinned).reduce((n, h) => n + h, 0) : 0);

/**
 * Rows between the Workspaces frame's top border and its divider, for a pane `height` rows tall, after the
 * Orchestration frame and the status rows (cleanups, check queue) under the divider.
 */
export const bodyRowsFor = (height: number, pinnedRows = 0, queueRowCount = 0) =>
  Math.max(1, height - pinnedRows - CHROME_TOP - CHROME_BOTTOM - queueRowCount);

/** The scroll offset closest to `offset` that shows entry `selected`, given each entry's row `heights`. */
export function scrollFor(selected: number, offset: number, heights: number[], rows: number): number {
  if (selected < offset) return selected;
  let start = offset;
  const span = () => heights.slice(start, selected + 1).reduce((n, h) => n + h, 0);
  while (start < selected && span() > rows) start++;
  return start;
}

/** Pull `offset` back so the list never leaves blank rows below it while earlier entries are hidden. */
export function clampScroll(offset: number, heights: number[], rows: number): number {
  let start = Math.max(0, Math.min(offset, heights.length - 1));
  const span = (from: number) => heights.slice(from).reduce((n, h) => n + h, 0);
  while (start > 0 && span(start - 1) <= rows) start--;
  return start;
}

/** Rows above the workspace list (top border) and below it (divider, two limit rows, key legend, bottom border). */
export const CHROME_TOP = 1;
export const CHROME_BOTTOM = 5;
/** Longest a title may wrap to. */
const MAX_TITLE_ROWS = 3;

const STATE_TEXT: Record<AgentState, { text: string; color: Color }> = {
  waiting: { text: "needs your input", color: "yellow" },
  empty: { text: "empty · can clean up", color: "grey" },
  done: { text: "finished", color: "green" },
  bg: { text: "finished · tasks running", color: "cyan" },
  busy: { text: "working", color: "blue" },
  idle: { text: "idle", color: "grey" },
  end: { text: "ended", color: "red" },
};

const BLOCK_TEXT: Record<RemovalBlock, { text: string; color: Color }> = {
  [RemovalBlock.MergedUnsaved]: { text: "merged · unsaved work", color: "yellow" },
};
const UNSAVED_TEXT: { text: string; color: Color } = { text: "ended · unsaved work", color: "red" };
const FAULT_COLOR: Color = "red";

/** An entry's status line, by priority: unreadable, cleanup failed, kept by the sweep, unsaved work, an icebox suggestion (unless the agent wants you), then the agent state. */
function statusFor(e: Entry): { text: string; color: Color } | undefined {
  if (e.fault) return { text: `error: ${e.fault}`, color: FAULT_COLOR };
  if (e.error) return { text: `cleanup failed: ${e.error}`, color: FAULT_COLOR };
  if (e.blocked) return BLOCK_TEXT[e.blocked];
  if (e.unsaved) return UNSAVED_TEXT;
  if (e.idleHint && !(e.state && ATTENTION.includes(e.state))) return { text: e.idleHint, color: "cyan" };
  return e.state ? STATE_TEXT[e.state] : undefined;
}

/** `text` broken at spaces into lines of at most `width` columns; an over-long word is split. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  const push = () => { if (line) lines.push(line); line = ""; };
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (textWidth(rest) > width) {
      push();
      let head = "";
      for (const ch of rest) {
        if (textWidth(head + ch) > width) break;
        head += ch;
      }
      if (!head) break;
      lines.push(head);
      rest = rest.slice(head.length);
    }
    if (!rest) continue;
    if (!line) line = rest;
    else if (textWidth(line) + 1 + textWidth(rest) <= width) line += ` ${rest}`;
    else { push(); line = rest; }
  }
  push();
  return lines.length ? lines : [""];
}

/** The unstyled title rows of an entry: the digit hint and glyph lead the first, the rest are indented under the text. */
function titleRows(e: Entry, index: number, inner: number): string[] {
  const digit = index < 9 ? `⌥${index + 1}` : String(index + 1).padStart(2);
  const lead = `${digit} ${e.glyph} `;
  const lines = wrapText(e.label, Math.max(1, inner - textWidth(lead)));
  const clipped = lines.length > MAX_TITLE_ROWS ? [...lines.slice(0, MAX_TITLE_ROWS - 1), `${lines.slice(MAX_TITLE_ROWS - 1).join(" ")}`] : lines;
  return clipped.map((l, i) => (i === 0 ? lead : " ".repeat(textWidth(lead))) + l);
}

/** Screen rows one entry takes: its wrapped title and a status line. */
export const entryHeight = (e: Entry, index: number, inner: number) => titleRows(e, index, inner).length + 1 + (e.stacks?.length ?? 0);

/** Row heights for the whole list in a pane `width` columns wide. */
export const entryHeights = (list: Entry[], width: number) => list.map((e, i) => entryHeight(e, i, Math.max(1, width - 4)));

/** The rows of one entry, each `inner` columns wide: the current one inverse, others with a coloured status line. */
export function entryLines(e: Entry, index: number, selected: boolean, inner: number): string[] {
  const titles = titleRows(e, index, inner).map((l) => fit(l, inner));
  const status = statusFor(e);
  const indent = " ".repeat(3 + textWidth(e.glyph) + 1);
  const sub = fit(`${indent}${status?.text ?? ""}`, inner);
  const stacks = (e.stacks ?? []).map((st) => fit(`${indent}${stackText(st)}`, inner));
  if (selected) return [...titles, sub, ...stacks].map(inverse);
  return [...titles, status ? colorize(sub, status.color) : sub, ...stacks.map(dim)];
}

const elapsed = (sinceMs: number, now: number) => {
  const secs = Math.max(0, Math.round((now - sinceMs) / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`;
};

/** The check queue under the divider: a row per running command, then how many wait; none when it is empty. */
export function queueRows(queue: { running: Ticket[]; waiting: Ticket[] }, inner: number, now = Date.now()): string[] {
  const running = queue.running.map((t) => colorize(fit(`▶ ${t.ws} ${elapsed(t.runningSinceMs ?? now, now)} ${t.command}`, inner), "blue"));
  const waiting = queue.waiting.length ? [dim(fit(`⧗ ${queue.waiting.length} waiting: ${queue.waiting.map((t) => t.ws).join(" ")}`, inner))] : [];
  return [...running, ...waiting];
}

/** ` · dropped` when an iceboxed workspace gave back its worktrees. */
const droppedLabel = (w: WorkspaceState): string => (w.iceboxed?.dropped?.length ? " · dropped" : "");

/** Iceboxed workspaces, one dim row each under the divider; they have no tab, so no card and no digit. */
export function icedRows(state: State, inner: number): string[] {
  const workspaces = state.workspaces as Record<string, unknown>;
  return Object.keys(workspaces)
    .filter((ws) => isIced(workspaces, ws))
    .sort(naturalSort)
    .map((ws) => dim(fit(`❄ ${ws} iceboxed${isWorkspaceState(workspaces[ws]) ? droppedLabel(workspaces[ws]) : ""}`, inner)));
}

/** Workspaces being removed in the background right now, labelled as their cards were; a malformed record is skipped (its card reports it). */
export function inFlightCleanups(state: State = readState(), now = Date.now()): CleanupInFlight[] {
  return Object.entries(state.workspaces as Record<string, unknown>).flatMap(([ws, w]) => {
    const record = removingRecord(w, now);
    return record ? [{ label: sidebarLabel(ws, readTopCache(ws)), sinceMs: Date.parse(record.removing.since) }] : [];
  });
}

/** What the sidebar reads on every poll. Injectable so a throwing reader can be tested without zellij, git or files. */
export interface SidebarReaders {
  tabOrder: () => string[];
  /** Reopen a closed orchestration tab (a no-op under a user layout). */
  keepOrchestration: (order: string[]) => void;
  /** Start the merged-PR sweep when this sidebar's turn comes. */
  sweep: () => void;
  readState: (fallback: State) => { state: State; fault?: string };
  entries: (order: string[], state: State) => Entry[];
  reap: (list: Entry[]) => ReapResult;
  /** The rows under the divider: cleanups, then the check queue. */
  status: (state: State, inner: number) => string[];
  limits: () => Limits | undefined;
}

/** One poll's result. The last good one is kept, so a poll that fails keeps the list on screen. */
export interface Model {
  list: Entry[];
  status: string[];
  limits: Limits | undefined;
  /** The last state that parsed. */
  state: State;
  /** The first thing that failed this poll, shown in the footer until a poll succeeds. */
  fault?: string;
}

export const EMPTY_MODEL: Model = { list: [], status: [], limits: undefined, state: { version: 1, workspaces: {} } };

const NO_REAP: ReapResult = { unsaved: new Set(), faults: new Map() };

/**
 * One poll. Each reader runs on its own: the first failure becomes `fault`, and its part keeps `last`'s value or an
 * empty one. State is read first, so a bad state file is reported as itself, not as whatever reader hit it next; the
 * merge sweep, which would only hit it again, waits for the file to be readable.
 */
export function gather(readers: SidebarReaders, inner: number, last: Model): Model {
  const faults: string[] = [];
  const attempt = <T>(what: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (e) {
      faults.push(`${what}: ${errorMessage(e)}`);
      return fallback;
    }
  };
  const read = attempt("state", () => readers.readState(last.state), { state: last.state });
  if (read.fault) {
    faults.push(read.fault);
  }
  const stateUnreadable = faults.length > 0;
  const state = stateUnreadable ? last.state : read.state;
  const order = attempt("tabs", readers.tabOrder, []);
  attempt("orchestration tabs", () => readers.keepOrchestration(order), undefined);
  if (!stateUnreadable) {
    attempt("merge sweep", readers.sweep, undefined);
  }
  const listed = attempt("workspace list", () => readers.entries(order, state), last.list);
  const reaped = attempt("auto-remove", () => readers.reap(listed), NO_REAP);
  const list = listed.map((e) => {
    const fault = reaped.faults.get(e.tab);
    return fault ? { ...e, fault } : reaped.unsaved.has(e.tab) ? { ...e, unsaved: true } : e;
  });
  const status = attempt("status rows", () => readers.status(state, inner), []);
  const limits = attempt("limits", readers.limits, undefined);
  return { list, status, limits, state, ...(faults[0] ? { fault: faults[0] } : {}) };
}

/**
 * The whole sidebar as `height` rows of `width` columns. A rounded frame titled "Orchestration" holds a card per
 * orchestration tab; below it a frame titled "Workspaces" holds a card per workspace (title wraps), scrolled by
 * `offset` (an index into the workspaces), then a divider, the `queue` rows (recent cleanups, then the check queue), the usage limits and the key legend,
 * with `version` set into the bottom border. `current` indexes the whole list.
 */
export function renderSidebar(list: Entry[], current: number, offset: number, height: number, width: number, limits: Limits | undefined, now = Date.now(), version = "", queue: string[] = [], footer: Footer = LEGEND_FOOTER, pending = ""): string[] {
  const inner = Math.max(0, width - 4);
  const pinned = pinnedCount(list);
  const cards = (from: number, to: number) => list.slice(from, to).flatMap((e, i) => entryLines(e, from + i, from + i === current, inner));
  const pinnedFrame = pinned ? [boxTop("Orchestration", width), ...cards(0, pinned).map(boxRow), boxBottom(width)] : [];
  const bodyRows = Math.max(0, height - pinnedFrame.length - CHROME_TOP - CHROME_BOTTOM - queue.length);
  const visible = cards(pinned + offset, list.length).slice(0, bodyRows);
  const body = [...visible, ...Array<string>(bodyRows - visible.length).fill(" ".repeat(inner))];
  return [
    ...pinnedFrame,
    boxTop("Workspaces", width),
    ...body.slice(0, bodyRows).map(boxRow),
    boxDivider(width),
    ...queue.map(boxRow),
    ...limitRows(limits, inner, now).map(boxRow),
    boxRow(footerRow(footer, inner, legend(list.length, pending))),
    boxBottom(width, version, "grey"),
  ];
}

/** What the sidebar's last row shows. */
export const FooterKind = { Legend: "legend", Prompt: "prompt", Busy: "busy", Error: "error" } as const;
export type FooterKind = (typeof FooterKind)[keyof typeof FooterKind];

/**
 * The new-workspace prompt. `text` is what the user has typed. `id` is set once an id alone was
 * submitted and the prompt is asking which repo it belongs to.
 */
export interface Prompt {
  text: string;
  id?: string;
}

export type Footer =
  | { kind: typeof FooterKind.Legend }
  | { kind: typeof FooterKind.Prompt; prompt: Prompt }
  | { kind: typeof FooterKind.Busy; id: string }
  | { kind: typeof FooterKind.Error; message: string };

export const LEGEND_FOOTER: Footer = { kind: FooterKind.Legend };

/** The footer to draw: the user's prompt or message first, else the last key press's fault, else this poll's, else the legend. */
export function footerToDraw(footer: Footer, inputFault: string | undefined, pollFault: string | undefined): Footer {
  const fault = inputFault ?? pollFault;
  return footer.kind === FooterKind.Legend && fault ? { kind: FooterKind.Error, message: fault } : footer;
}
export const EMPTY_PROMPT: Footer = { kind: FooterKind.Prompt, prompt: { text: "" } };

export const promptLabel = (p: Prompt) => (p.id === undefined ? "new ws: " : `repo for ${p.id}: `);

/** `text` in `width` columns, keeping its end visible: a cut starts with an ellipsis. */
function fitTail(text: string, width: number): string {
  if (textWidth(text) <= width) {
    return fit(text, width);
  }
  const tail = [...text].reduceRight((kept, ch) => (textWidth(ch + kept) <= width - 1 ? ch + kept : kept), "");
  return fit(`…${tail}`, width);
}

/** The footer as one row `inner` columns wide; the legend kind shows `legendText`. */
export function footerRow(footer: Footer, inner: number, legendText = legend(0)): string {
  switch (footer.kind) {
    case FooterKind.Legend:
      return dim(fit(legendText, inner));
    case FooterKind.Prompt:
      return fitTail(`${promptLabel(footer.prompt)}${footer.prompt.text}█`, inner);
    case FooterKind.Busy:
      return dim(fit(`starting ${footer.id}…`, inner));
    case FooterKind.Error:
      return colorize(fit(footer.message, inner), "red");
  }
}

export const PromptStepKind = { Edit: "edit", Cancel: "cancel", Submit: "submit" } as const;
export type PromptStepKind = (typeof PromptStepKind)[keyof typeof PromptStepKind];

export type PromptStep =
  | { kind: typeof PromptStepKind.Edit; prompt: Prompt }
  | { kind: typeof PromptStepKind.Cancel }
  | { kind: typeof PromptStepKind.Submit; prompt: Prompt };

const isPrintable = (key: string) => [...key].length === 1 && key >= " " && key !== "\x7f";

/**
 * One input applied to the open prompt. Every key goes here while the prompt is open, so `q`, `j` and
 * digits are typed rather than acting as sidebar keys. Esc and Ctrl-C cancel; clicks and arrows do nothing.
 */
export function promptInput(p: Prompt, input: Input): PromptStep {
  if (input.kind !== "key") {
    return { kind: PromptStepKind.Edit, prompt: p };
  }
  if (input.key === "escape" || input.key === "ctrl-c") {
    return { kind: PromptStepKind.Cancel };
  }
  if (input.key === "enter") {
    return { kind: PromptStepKind.Submit, prompt: p };
  }
  if (input.key === "\x7f" || input.key === "\b") {
    return { kind: PromptStepKind.Edit, prompt: { ...p, text: [...p.text].slice(0, -1).join("") } };
  }
  if (isPrintable(input.key)) {
    return { kind: PromptStepKind.Edit, prompt: { ...p, text: p.text + input.key } };
  }
  return { kind: PromptStepKind.Edit, prompt: p };
}

export const StartPlanKind = { Run: "run", AskRepo: "ask-repo", Invalid: "invalid" } as const;
export type StartPlanKind = (typeof StartPlanKind)[keyof typeof StartPlanKind];

export type StartPlan =
  | { kind: typeof StartPlanKind.Run; repo: string; id: string }
  | { kind: typeof StartPlanKind.AskRepo; id: string }
  | { kind: typeof StartPlanKind.Invalid; message: string };

/**
 * What a submitted prompt asks for. `<repo> <id>` runs as typed. An id alone uses the one repo the
 * workspace holds (`holds`); with none or several it asks for the repo, keeping the id.
 */
export function parseStart(p: Prompt, holds: readonly string[]): StartPlan {
  const words = p.text.trim().split(/\s+/).filter(Boolean);
  if (p.id !== undefined) {
    return words.length === 1
      ? { kind: StartPlanKind.Run, repo: words[0]!, id: p.id }
      : { kind: StartPlanKind.Invalid, message: `type one repo name for ${p.id}, such as ${holds[0] ?? "my-repo"}` };
  }
  if (words.length === 2) {
    return { kind: StartPlanKind.Run, repo: words[0]!, id: words[1]! };
  }
  if (words.length === 1) {
    return holds.length === 1 ? { kind: StartPlanKind.Run, repo: holds[0]!, id: words[0]! } : { kind: StartPlanKind.AskRepo, id: words[0]! };
  }
  return { kind: StartPlanKind.Invalid, message: `type <repo> <id> or <id>, such as ${holds[0] ?? "my-repo"} 123` };
}

/** Exit code and stderr of a finished command. */
export interface Finished {
  code: number;
  stderr: string;
}

export type Spawner = (cmd: string[]) => Promise<Finished>;

const spawnAsync: Spawner = async (cmd) => {
  const p = Bun.spawn({ cmd, cwd: spawnCwd(), stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  return { code, stderr };
};

/** The last non-empty stderr line without the CLI's `overbridge: ` prefix, else a line naming the command. */
export function startError(repo: string, id: string, result: Finished): string {
  const last = result.stderr.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  return last?.replace(/^overbridge: /, "") ?? `overbridge start ${repo} ${id} failed with exit code ${result.code}`;
}

/**
 * Run `overbridge start <repo> <id>` as a child process, so its git fetch does not freeze the pane and its
 * output does not draw over it. The child inherits the session's environment, so it opens the new tab or focuses an existing one.
 * Resolves to the footer to show next: the legend on success, the error otherwise.
 */
export async function runStart(repo: string, id: string, spawn: Spawner = spawnAsync): Promise<Footer> {
  const result = await spawn([...selfCommand(), "start", repo, id]).catch((e: unknown): Finished => ({ code: -1, stderr: `could not run overbridge start: ${(e as Error).message}` }));
  return result.code === 0 ? LEGEND_FOOTER : { kind: FooterKind.Error, message: startError(repo, id, result) };
}

/**
 * The entry index under screen row `row`, given each entry's row `heights` and a list drawn from row `top`
 * for `rows` rows; undefined for none.
 */
export function entryAt(row: number, offset: number, heights: number[], rows: number, top = CHROME_TOP): number | undefined {
  let y = top;
  for (let i = offset; i < heights.length; i++) {
    if (y + heights[i]! > top + rows) return undefined;
    if (row < y + heights[i]!) return row >= y ? i : undefined;
    y += heights[i]!;
  }
  return undefined;
}

/** The entry index under a click on screen row `row`, in the Orchestration frame or the scrolled Workspaces one. */
function clickTarget(row: number, offset: number, heights: number[], rows: number, pinned: number): number | undefined {
  const pinnedRows = pinnedRowsFor(heights, pinned);
  if (row < pinnedRows) {
    return entryAt(row, 0, heights.slice(0, pinned), pinnedRows - 2, 1);
  }
  const hit = entryAt(row, offset, heights.slice(pinned), rows, pinnedRows + CHROME_TOP);
  return hit === undefined ? undefined : pinned + hit;
}

/**
 * Which tab an input asks for, as an index into the whole list; undefined for none or for the current one.
 * Up/`k` and down/`j` step across both frames (no wrap), a click picks a row. The first `pinned`
 * entries are the Orchestration frame's; `offset` scrolls the rest. Digits go through `stepFor`.
 */
export function targetFor(input: Input, current: number, offset: number, heights: number[], rows: number, pinned = 0): number | undefined {
  const count = heights.length;
  let target: number | undefined;
  if (input.kind === "click") target = clickTarget(input.row, offset, heights, rows, pinned);
  else if (input.key === "up" || input.key === "k") target = current - 1;
  else if (input.key === "down" || input.key === "j") target = current + 1;
  return inRange(target, count, current);
}

const inRange = (target: number | undefined, count: number, current: number) =>
  target !== undefined && target >= 0 && target < count && target !== current ? target : undefined;

/** What one input does: a tab to go to, a way to travel through the history, and the digit held after it. */
export interface Step {
  target?: number;
  travel?: Travel;
  /** A digit waiting for a second one; empty for none. */
  pending: string;
}

/**
 * Like `targetFor`, plus ←/`h` and →/`l` for the history and one- or two-digit tab numbers. A digit is held in
 * `pending` only when a two-digit number could start with it; a second digit then picks that tab, falling back to the
 * held digit's own tab when the number is past the end. Any other input drops a held digit.
 */
export function stepFor(input: Input, current: number, offset: number, heights: number[], rows: number, pinned = 0, pending = ""): Step {
  const count = heights.length;
  if (input.kind === "key" && /^[0-9]$/.test(input.key)) {
    if (pending) {
      const number = Number(pending + input.key);
      return { target: inRange((number <= count ? number : Number(pending)) - 1, count, current), pending: "" };
    }
    const held = Number(input.key);
    if (held === 0) {
      return { pending: "" };
    }
    return count >= held * 10 ? { pending: input.key } : { target: inRange(held - 1, count, current), pending: "" };
  }
  if (input.kind === "key" && (input.key === "left" || input.key === "h")) {
    return { travel: Travel.Back, pending: "" };
  }
  if (input.kind === "key" && (input.key === "right" || input.key === "l")) {
    return { travel: Travel.Forward, pending: "" };
  }
  return { target: targetFor(input, current, offset, heights, rows, pinned), pending: "" };
}

/**
 * The tab a digit held by `self`'s sidebar goes to once the wait runs out. None when `focused` (the tab the multiplexer has
 * focused now) is another one, so leaving the tab some other way drops the digit instead of pulling you back.
 */
export function commitDigit(pending: string, list: Entry[], self: string, focused: string | undefined): number | undefined {
  if (!pending || focused !== self) {
    return undefined;
  }
  return inRange(Number(pending) - 1, list.length, list.findIndex((e) => e.tab === self));
}

/** Each sidebar records its multiplexer pane id here, so another tab's sidebar can focus it. */
const paneFile = (ws: string) => join(metaDir(), "sidebars", ws);

function registerPane(ws: string) {
  const id = defaultMux().ownPaneId();
  if (id === undefined) return;
  mkdirSync(join(metaDir(), "sidebars"), { recursive: true });
  writeFileSync(paneFile(ws), id);
}

const sidebarPane = (ws: string): string | undefined => {
  try {
    return readFileSync(paneFile(ws), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
};

/**
 * Switch to `tab` and focus its sidebar; false when the multiplexer could not go to the tab. Focusing a sidebar
 * that already has focus can fail, so its result is ignored.
 */
export function switchTab(tab: string, mux: Mux = defaultMux()): boolean {
  if (!mux.goToTab(tab).ok) {
    return false;
  }
  const pane = sidebarPane(tab);
  if (pane !== undefined) {
    mux.focusPane(pane);
  }
  return true;
}

/** Go from `self` to `tab`, picked any way but ← and →, recording the visit in the session's history. */
export function visitTab(self: string, tab: string, mux?: Mux): boolean {
  const before = readHistory();
  return moveWithHistory(before, visit(before, self), () => switchTab(tab, mux));
}

/** ← or → from `self`, skipping tabs no longer in `list`; false when there is nowhere to go or the switch failed. */
export function travelTab(self: string, way: Travel, list: Entry[], mux?: Mux): boolean {
  const before = readHistory();
  const moved = travel(before, way, self, new Set(list.map((e) => e.tab)));
  if (moved.target === undefined) {
    return false;
  }
  const target = moved.target;
  return moveWithHistory(before, moved.history, () => switchTab(target, mux));
}

/** `overbridge sidebar [--ws]`. `q` or Ctrl-C quits. */
export async function sidebar(wsOpt?: string) {
  const self = (wsOpt === undefined ? undefined : orchestrationTab(wsOpt)?.tab) ?? requireWs(wsOpt);
  if (!process.stdin.isTTY) throw new Error("overbridge sidebar needs a terminal");
  registerPane(self);

  // Read once at start, so a pane left running across an upgrade shows the version it runs.
  const version = overbridgeVersion();
  const userLayout = existsSync(userLayoutPath());
  const readers: SidebarReaders = {
    tabOrder: () => readView().order,
    // a user layout decides its own tabs, so only the generated one gets its orchestration tabs back
    keepOrchestration: (order) => { if (!userLayout) ensureOrchestrationTabs(order); },
    sweep: createSweepTrigger({ serverOwns: () => serverOwnsSweep(), claim: claimSweep, start: startSweep, now: Date.now }),
    readState: tryReadState,
    entries,
    reap: createReaper(),
    status: (state, inner) => [...icedRows(state, inner), ...cleanupRows(inFlightCleanups(state), cleanupRecords(state.cleanups), inner, Date.now(), state.mergeSweepAt), ...queueRows(readQueue(), inner)],
    limits: readLimits,
  };
  let last: Model = EMPTY_MODEL;
  let offset = 0;
  let footer: Footer = LEGEND_FOOTER;
  let statusRowCount = 0;
  let pending = "";
  let digitTimer: ReturnType<typeof setTimeout> | undefined;
  const hold = (digit: string) => {
    clearTimeout(digitTimer);
    pending = digit;
    digitTimer = digit ? setTimeout(commit, DIGIT_MS) : undefined;
  };
  /** What the last key press threw, shown in the footer until the next key press; a poll does not clear it. */
  let inputFault: string | undefined;
  /** Run `fn`; when it throws, the error goes to the footer instead of ending the pane. */
  const guarded = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      inputFault = `${what}: ${errorMessage(e)}`;
    }
  };
  const commit = () => {
    guarded("go to tab", () => {
      const list = last.list;
      const target = commitDigit(pending, list, self, currentTab());
      hold("");
      if (target !== undefined) {
        visitTab(self, list[target]!.tab);
      }
    });
    draw();
  };
  const size = () => ({ height: process.stdout.rows ?? 24, width: process.stdout.columns ?? 28 });
  const painter = createPainter((text) => process.stdout.write(text));
  let lastGatherAtMs = 0;
  /** Gather, then paint; neither may end the pane, so a failure is named in the footer and the next poll tries again. */
  const draw = () => {
    const { height, width } = size();
    const inner = Math.max(0, width - 4);
    lastGatherAtMs = Date.now();
    try {
      last = gather(readers, inner, last);
    } catch (e) {
      last = { ...last, fault: `sidebar: ${errorMessage(e)}` };
    }
    try {
      const { list, status } = last;
      const current = Math.max(0, list.findIndex((e) => e.tab === self));
      const heights = entryHeights(list, width);
      const pinned = pinnedCount(list);
      const workspaceHeights = heights.slice(pinned);
      statusRowCount = status.length;
      const rows = bodyRowsFor(height, pinnedRowsFor(heights, pinned), statusRowCount);
      const scrolled = current >= pinned ? scrollFor(current - pinned, offset, workspaceHeights, rows) : offset;
      offset = clampScroll(scrolled, workspaceHeights, rows);
      painter.paint(frame(renderSidebar(list, current, offset, height, width, last.limits, Date.now(), version, status, footerToDraw(footer, inputFault, last.fault), pending), height, width));
    } catch (e) {
      painter.paint(frame([colorize(fit(`sidebar: ${errorMessage(e)}`, width), FAULT_COLOR)], height, width));
    }
  };
  const show = (next: Footer) => {
    footer = next;
    draw();
  };
  const submit = (prompt: Prompt) => {
    const plan = parseStart(prompt, Object.keys(last.state.workspaces[self]?.repos ?? {}));
    switch (plan.kind) {
      case StartPlanKind.AskRepo:
        return show({ kind: FooterKind.Prompt, prompt: { text: "", id: plan.id } });
      case StartPlanKind.Invalid:
        return show({ kind: FooterKind.Error, message: plan.message });
      case StartPlanKind.Run:
        show({ kind: FooterKind.Busy, id: plan.id });
        return void runStart(plan.repo, plan.id).then(show);
    }
  };
  /** Feed one input to the footer; true when the footer took it and the sidebar keys skip it. */
  const footerTakes = (input: Input): boolean => {
    if (footer.kind === FooterKind.Prompt) {
      const step = promptInput(footer.prompt, input);
      if (step.kind === PromptStepKind.Cancel) {
        show(LEGEND_FOOTER);
      } else if (step.kind === PromptStepKind.Submit) {
        submit(step.prompt);
      } else {
        show({ kind: FooterKind.Prompt, prompt: step.prompt });
      }
      return true;
    }
    if (footer.kind === FooterKind.Error) {
      show(LEGEND_FOOTER);
    }
    if (input.kind === "key" && input.key === "s") {
      if (footer.kind !== FooterKind.Busy) {
        show(EMPTY_PROMPT);
      }
      return true;
    }
    return false;
  };

  await new Promise<void>((resolve) => {
    const quit = () => {
      clearInterval(timer);
      hold("");
      stopWatch();
      process.stdout.write(LEAVE_SCREEN);
      process.stdin.setRawMode(false);
      rmSync(paneFile(self), { force: true });
      resolve();
    };
    process.stdout.write(ENTER_SCREEN);
    painter.invalidate();
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (buf) => {
      // one draw per chunk, so a fault from any key in it stays on screen
      inputFault = undefined;
      for (const input of decodeInput(buf.toString())) {
        let taken = false;
        guarded("key", () => {
          taken = footerTakes(input);
        });
        if (taken) {
          hold("");
          continue;
        }
        // an open prompt takes q and ctrl-c as text and cancel, so quit only once the footer has passed on the key
        if (input.kind === "key" && (input.key === "q" || input.key === "ctrl-c")) return quit();
        guarded("key", () => {
          if (input.kind === "key" && input.key === "n") {
            hold("");
            next(self);
            return;
          }
          if (input.kind === "key" && input.key === PERF_KEY) {
            hold("");
            const perf = last.list.find((e) => e.tab === PERF_TAB);
            if (perf && perf.tab !== self) visitTab(self, perf.tab);
            return;
          }
          // the list on screen, so a click lands on the card the user saw
          const list = last.list;
          const current = list.findIndex((e) => e.tab === self);
          const { height, width } = size();
          const heights = entryHeights(list, width);
          const pinned = pinnedCount(list);
          const step = stepFor(input, current, offset, heights, bodyRowsFor(height, pinnedRowsFor(heights, pinned), statusRowCount), pinned, pending);
          hold(step.pending);
          if (step.travel !== undefined) {
            travelTab(self, step.travel, list);
          } else if (step.target !== undefined) {
            visitTab(self, list[step.target]!.tab);
          }
        });
      }
      draw();
    });
    process.stdout.on("resize", () => {
      painter.invalidate();
      draw();
    });
    // a hidden tab's sidebar gathers only every HIDDEN_POLL_MS, and catches up on the first tick after its tab is focused
    const tick = () => {
      if (shouldPoll(self, readView(), lastGatherAtMs, Date.now())) {
        draw();
      }
    };
    const timer = setInterval(tick, POLL_MS);
    const stopWatch = watchState(tick);
    draw();
  });
}
