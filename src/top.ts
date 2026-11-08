import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { AppStatus, appAvailable, appStatus, appUrl, readRecord } from "./apps";
import { readAgentState } from "./agent-state";
import * as git from "./git";
import { metaDir, wsDir, worktreePath } from "./paths";
import { providerFor, refreshTitle } from "./pm";
import type { Provider } from "./pm/provider";
import { type AppSpec, type Ide, loadRepoConfig, type ProjectManagement } from "./project-config";
import { getWorkspace, readState } from "./state";
import { boxBottom, boxRow, boxTop, type Color, colorize, fit, inverse, textWidth } from "./term";
import { stackOf, localStacks } from "./stack";
import { run } from "./util";

const safeStacks = (repo: string) => {
  try {
    return localStacks(repo);
  } catch {
    return [];
  }
};

const ESC = "\x1b";

/**
 * The top panel: a headline, link buttons, an editor button, app toggles and a
 * message row. It renders from `<meta>/top/<ws>.json` and local app records only,
 * never the network; `refreshTop` is what fills the cache.
 */

/** What the PR rows and their action buttons need. */
export interface PrInfo {
  repo: string;
  number: number;
  title: string;
  draft: boolean;
  /** The repo worktree the `gh` actions run in. */
  dir: string;
  /** Every PR of the stack this PR belongs to, bottom first; empty when unstacked. */
  stack: number[];
}

export interface TopLink {
  label: string;
  url: string;
  pr?: PrInfo;
  /** A PR link's state: drives its colour and icon. */
  status?: PrStatus;
}

export const PR_STATUSES = ["merged", "mergeable", "failing", "conflict", "pending", "blocked", "closed", "unknown"] as const;
export type PrStatus = (typeof PR_STATUSES)[number];

/** What `gh pr view --json state,mergeable,mergeStateStatus,statusCheckRollup` returns, as far as we read it. */
export interface PrView {
  url?: string;
  title?: string;
  isDraft?: boolean;
  state?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  statusCheckRollup?: { status?: string; conclusion?: string; state?: string }[];
}

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const PENDING = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);

/** Merged, failing build, conflicts, pending build, then whether it can merge: the first that applies. */
export function classifyPr(pr: PrView): PrStatus {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  const checks = pr.statusCheckRollup ?? [];
  if (checks.some((c) => FAILED.has(c.conclusion ?? "") || FAILED.has(c.state ?? ""))) return "failing";
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") return "conflict";
  if (checks.some((c) => PENDING.has(c.state ?? "") || (c.status !== undefined && c.status !== "COMPLETED"))) return "pending";
  if (["CLEAN", "UNSTABLE", "HAS_HOOKS"].includes(pr.mergeStateStatus ?? "")) return "mergeable";
  if (["BLOCKED", "BEHIND", "DRAFT"].includes(pr.mergeStateStatus ?? "")) return "blocked";
  return pr.mergeable === "MERGEABLE" ? "mergeable" : "unknown";
}

export const PR_LOOK: Record<PrStatus, { icon: string; color: Color }> = {
  merged: { icon: "🟣", color: "purple" },
  mergeable: { icon: "🟢", color: "green" },
  failing: { icon: "🔴", color: "red" },
  conflict: { icon: "🔴", color: "red" },
  pending: { icon: "🟡", color: "yellow" },
  blocked: { icon: "🔵", color: "blue" },
  closed: { icon: "⚫", color: "grey" },
  unknown: { icon: "⚪", color: "grey" },
};

/** What `refreshTop` stores. `message` is the last problem it hit, shown on the message row. */
export interface TopCache {
  headline?: string;
  /** The item's title alone, without its id. */
  title?: string;
  links: TopLink[];
  /** Every claimed repo's PR is open (and there is at least one claim). Half of what makes a workspace cleanable. */
  prsOpen?: boolean;
  message?: string;
  at: number;
}

export interface TopApp {
  repo: string;
  spec: AppSpec;
  repoDir: string;
  status: AppStatus;
  port?: number;
  /** False when `when:` rules the app out on the current branch. */
  available: boolean;
}

const CONVENTIONAL = /^(?:feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)(?:\([^)]*\))?!?:\s*/i;

/** A title without its conventional-commit prefix: `feat(scope): add x` is `add x`. */
export const stripConventional = (title: string): string => title.replace(CONVENTIONAL, "").trim() || title;

/**
 * What the sidebar shows for a workspace: the item's title with no id and no conventional prefix,
 * else the workspace name when no title is cached yet.
 */
export function sidebarLabel(ws: string, cache: Pick<TopCache, "headline" | "title">): string {
  const title = cache.title ?? (cache.headline?.includes(" ") ? cache.headline.replace(/^\S+\s+/, "") : undefined);
  return title ? stripConventional(title) : ws;
}

export interface TopSnapshot {
  ws: string;
  dir: string;
  headline?: string;
  /** The task name: the item's title without id or conventional prefix, else the workspace name. */
  title?: string;
  links: TopLink[];
  ide?: Ide;
  /** `$OVERBRIDGE_IDE`, else `$EDITOR`; used for the editor button when no `ide` is configured. */
  editor?: string;
  apps: TopApp[];
  /** The workspace can be wiped: PRs open, nothing uncommitted, nothing unpushed. */
  cleanup?: boolean;
  message?: string;
}

export const IDE_COMMANDS: Record<Ide, string> = { vscode: "code", zed: "zed", webstorm: "webstorm" };

const cacheFile = (ws: string) => join(metaDir(), "top", `${ws}.json`);

export function readTopCache(ws: string): TopCache {
  try {
    return JSON.parse(readFileSync(cacheFile(ws), "utf8"));
  } catch {
    return { links: [], at: 0 };
  }
}

function writeTopCache(ws: string, cache: TopCache) {
  mkdirSync(join(metaDir(), "top"), { recursive: true });
  const tmp = `${cacheFile(ws)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n");
  renameSync(tmp, cacheFile(ws));
}

function parsePrView(out: string | undefined): PrView | undefined {
  try {
    return out ? (JSON.parse(out) as PrView) : undefined;
  } catch {
    return undefined;
  }
}

export interface RefreshDeps {
  provider?: (pm: ProjectManagement, dir: string) => Provider;
  /** Run a command in `cwd`; returns trimmed stdout, or undefined on failure. */
  exec?: (cmd: string[], cwd: string) => string | undefined;
}

const defaultExec = (cmd: string[], cwd: string) => {
  const r = run(cmd, { cwd });
  return r.ok && r.stdout ? r.stdout : undefined;
};

/**
 * Rebuild the cache for `ws`: the work item its branches name (headline and link) and a
 * link per claimed PR. Problems land in `message` rather than throwing, so a flaky
 * network leaves the panel up with the old values.
 */
export function refreshTop(ws: string, deps: RefreshDeps = {}): TopCache {
  const provider = deps.provider ?? providerFor;
  const exec = deps.exec ?? defaultExec;
  const old = readTopCache(ws);
  const claims = Object.entries(getWorkspace(readState(), ws).repos);
  const links: TopLink[] = [];
  const problems: string[] = [];
  const claimed = claims.filter(([, c]) => c.branch).length;
  let openPrs = 0;
  let headline: string | undefined;
  let itemTitle: string | undefined;
  let itemLink: TopLink | undefined;

  for (const [repo, claim] of claims) {
    const dir = worktreePath(ws, repo);
    let config;
    try {
      config = loadRepoConfig(dir);
    } catch (e) {
      problems.push(`${repo}: ${(e as Error).message}`);
      continue;
    }
    const pm = config.projectManagement;
    if (pm && claim.branch && !itemLink) {
      try {
        const p = provider(pm, dir);
        const id = p.idFromBranch(claim.branch);
        if (id) {
          const title = refreshTitle(p, pm.project, id);
          headline = title ? `${id} ${title}` : id;
          itemTitle = title || undefined;
          itemLink = { label: id, url: p.link(id) };
        }
      } catch (e) {
        problems.push(`${repo}: ${(e as Error).message}`);
      }
    }
    if (claim.pr !== undefined) {
      const view = parsePrView(exec(["gh", "pr", "view", String(claim.pr), "--json", "url,title,isDraft,state,mergeable,mergeStateStatus,statusCheckRollup"], dir));
      if (view?.url) {
        const layers = stackOf(safeStacks(repo), claim.branch)?.layers ?? [];
        const stack = layers.length > 1 ? layers.flatMap((l) => (l.pr === undefined ? [] : [l.pr])) : [];
        links.push({
          label: claims.length > 1 ? `${repo} #${claim.pr}` : `PR #${claim.pr}`,
          url: view.url,
          status: classifyPr(view),
          pr: { repo, number: claim.pr, title: view.title ?? "", draft: view.isDraft === true, dir, stack },
        });
      }
      else problems.push(`${repo}: no URL for PR #${claim.pr}`);
      if (view?.state === "OPEN") openPrs++;
    }
  }

  const cache: TopCache = {
    // keep the previous values when this run found nothing, so the panel never goes blank on an outage
    ...(headline ?? old.headline ? { headline: headline ?? old.headline } : {}),
    ...(itemTitle ?? old.title ? { title: itemTitle ?? old.title } : {}),
    links: itemLink || links.length ? [...(itemLink ? [itemLink] : []), ...links] : old.links,
    // released repos hold no branch, so only claimed branches need an open PR
    prsOpen: claimed > 0 && openPrs === claimed,
    ...(problems.length ? { message: problems.join("; ") } : {}),
    at: Date.now(),
  };
  writeTopCache(ws, cache);
  return cache;
}

/**
 * Whether `ws` can be wiped: its agent is empty (just started or cleared), or every claimed branch has an open PR (from the cache), and no repo
 * holds uncommitted changes or unpushed commits (read from git now, so it is never stale).
 */
export function cleanable(ws: string): boolean {
  if (!readTopCache(ws).prsOpen && readAgentState(ws) !== "empty") return false;
  return Object.keys(getWorkspace(readState(), ws).repos).every((repo) => {
    const wt = worktreePath(ws, repo);
    return !git.isDirty(wt) && !git.hasUnpushed(wt);
  });
}

/** Presses of Cleanup within this long of the first one confirm it. */
export const CLEANUP_ARM_MS = 5_000;

/** The first press arms Cleanup; a second within `CLEANUP_ARM_MS` confirms. Pure so the timing is testable. */
export function pressCleanup(armedAt: number | undefined, now: number): { confirmed: boolean; armedAt: number | undefined } {
  if (armedAt !== undefined && now - armedAt <= CLEANUP_ARM_MS) return { confirmed: true, armedAt: undefined };
  return { confirmed: false, armedAt: now };
}

/** Everything the panel draws, from the cache and local app records. */
export async function snapshotTop(ws: string, env: NodeJS.ProcessEnv = process.env): Promise<TopSnapshot> {
  const cache = readTopCache(ws);
  const claims = Object.keys(getWorkspace(readState(), ws).repos);
  const apps: TopApp[] = [];
  let ide: Ide | undefined;
  const problems: string[] = cache.message ? [cache.message] : [];
  for (const repo of claims) {
    const repoDir = worktreePath(ws, repo);
    try {
      const config = loadRepoConfig(repoDir);
      ide ??= config.ide;
      for (const spec of config.apps) {
        const record = readRecord(ws, repo, spec.id);
        apps.push({
          repo,
          spec,
          repoDir,
          status: await appStatus(ws, repo, spec),
          ...(record?.port === undefined ? {} : { port: record.port }),
          available: appAvailable(spec, repo, repoDir),
        });
      }
    } catch (e) {
      problems.push(`${repo}: ${(e as Error).message}`);
    }
  }
  const editor = ide ? undefined : env.OVERBRIDGE_IDE?.trim() || env.EDITOR?.trim() || undefined;
  return {
    ws,
    dir: wsDir(ws),
    ...(cache.headline ? { headline: cache.headline } : {}),
    title: sidebarLabel(ws, cache),
    links: cache.links,
    ...(ide ? { ide } : {}),
    ...(editor ? { editor } : {}),
    apps,
    ...(cleanable(ws) ? { cleanup: true } : {}),
    ...(problems.length ? { message: problems.join("; ") } : {}),
  };
}

export type PaneKind = "claude" | "terminal" | "diff";

export type Action =
  | { kind: "link"; url: string }
  | { kind: "editor"; cmd: string[]; dir: string }
  | { kind: "app"; app: TopApp }
  | { kind: "pane"; pane: PaneKind }
  | { kind: "ready"; pr: PrInfo }
  | { kind: "merge"; pr: PrInfo }
  | { kind: "cleanup" };

export interface Button {
  label: string;
  action: Action;
  /** The key that presses it while the panel is focused; shown in the button. */
  key?: string;
  color?: Color;
  /** Launchers (editor, apps, panes) sit at the right; status buttons (links, Cleanup) at the left. */
  side?: "left" | "right";
  /** Index of the PR this button belongs to: those buttons sit on that PR's own row, the PR first and its actions at the right. */
  prRow?: number;
}

const MARKS: Record<AppStatus, string> = {
  [AppStatus.Stopped]: "⚫",
  [AppStatus.Starting]: "🟡",
  [AppStatus.Running]: "🟢",
  [AppStatus.Exited]: "🔴",
};

const APP_COLORS: Record<AppStatus, Color | undefined> = {
  [AppStatus.Stopped]: undefined,
  [AppStatus.Starting]: "yellow",
  [AppStatus.Running]: "green",
  [AppStatus.Exited]: "red",
};

export const PANE_BUTTONS: { pane: PaneKind; label: string }[] = [
  { pane: "claude", label: "🤖 claude" },
  { pane: "terminal", label: "💻 terminal" },
  { pane: "diff", label: "🔀 diff" },
];

/** Where the editor commands live when the usual name is not on PATH (nixpkgs ships Zed as `zeditor`). */
export const ALT_COMMANDS: Record<string, string> = { zed: "zeditor" };

export const appUrlOf = (app: TopApp): string | undefined => appUrl(app.spec, app.port);

/** Split an editor env value like `code -w` (or an ide name like `zed`) into a command and a label. */
function editorFromEnv(editor: string | undefined): { label: string; cmd: string[] } | undefined {
  const cmd = editor?.split(/\s+/).filter(Boolean);
  if (!cmd?.length) return undefined;
  const name = cmd[0]!;
  if (cmd.length === 1 && name in IDE_COMMANDS) return { label: name, cmd: [IDE_COMMANDS[name as Ide]] };
  return { label: basename(name), cmd };
}

/**
 * Give each button its key: `i` the work item, `p` the PR (then u, y, w, z), `1` to `9` the apps,
 * `e` the editor, `c` `t` `d` the panes, `x` Cleanup, and on the first PR's row `g` ready/draft, `m` merge. Buttons past the available keys get none.
 */
function withKeys(list: Button[]): Button[] {
  let app = 0;
  return list.map((b) => {
    const a = b.action;
    let key: string | undefined;
    if (a.kind === "link") return b;
    else if (a.kind === "ready") key = b.prRow === 0 ? "g" : undefined;
    else if (a.kind === "merge") key = b.prRow === 0 ? "m" : undefined;
    else if (a.kind === "app") key = app < 9 ? String(++app) : undefined;
    else if (a.kind === "editor") key = "e";
    else if (a.kind === "pane") key = { claude: "c", terminal: "t", diff: "d" }[a.pane];
    else key = "x";
    return key ? { ...b, key } : b;
  });
}

/**
 * Buttons in display order. Left: work item and PR links (coloured by PR status), then Cleanup when the
 * workspace can be wiped. Right: apps, the editor, then the claude / terminal / diff pane toggles.
 * Apps ruled out by `when:` are left out.
 */
/** Keys for extra PR buttons after `p`; none clash with the panel's own keys. */
const PR_KEYS = ["p", "u", "y", "w", "z"];

export function buttons(snap: TopSnapshot): Button[] {
  const prKeys = [...PR_KEYS];
  const issueKeys = ["i"];
  const out: Button[] = [];
  let prRow = 0;
  for (const l of snap.links) {
    const isPr = l.status !== undefined || l.label.includes("#");
    const key = isPr ? prKeys.shift() : issueKeys.shift();
    const look = l.status ? PR_LOOK[l.status] : undefined;
    const pr = l.pr;
    const name = pr ? `${pr.repo} #${pr.number}${pr.title ? ` ${pr.title}` : ""}` : l.label;
    out.push({
      label: look ? `${look.icon} ${name}` : `📋 ${name}`,
      action: { kind: "link", url: l.url },
      side: "left",
      ...(pr ? { prRow } : {}),
      ...(key ? { key } : {}),
      ...(look ? { color: look.color } : {}),
    });
    if (pr) {
      const row = prRow++;
      if (l.status !== "merged" && l.status !== "closed") {
        out.push({ label: pr.draft ? "✅ Ready" : "📝 Draft", action: { kind: "ready", pr }, side: "right", prRow: row });
        if (l.status === "mergeable" && !pr.draft) out.push({ label: pr.stack.length > 1 ? "🟣 Merge stack" : "🟣 Merge", action: { kind: "merge", pr }, side: "right", color: "purple", prRow: row });
      }
    }
  }
  if (snap.cleanup) out.push({ label: "🧹 Cleanup", action: { kind: "cleanup" }, side: "left" });
  for (const app of snap.apps) {
    if (!app.available) continue;
    const port = app.status === AppStatus.Stopped || app.port === undefined ? "" : ` :${app.port}`;
    const color = APP_COLORS[app.status];
    out.push({ label: `${MARKS[app.status]} ${app.spec.label}${port}`, action: { kind: "app", app }, side: "right", ...(color ? { color } : {}) });
  }
  const editor = snap.ide ? { label: snap.ide, cmd: [IDE_COMMANDS[snap.ide]] } : editorFromEnv(snap.editor);
  if (editor) out.push({ label: `📝 ${editor.label}`, action: { kind: "editor", cmd: editor.cmd, dir: snap.dir }, side: "right" });
  for (const p of PANE_BUTTONS) out.push({ label: p.label, action: { kind: "pane", pane: p.pane }, side: "right" });
  return withKeys(out);
}

export interface Placed {
  button: Button;
  /** 0-based row within the panel and 0-based start column. */
  row: number;
  col: number;
  width: number;
}

export interface Frame {
  /** Plain text rows, border included (buttons too, for reading); the cursor and colours are drawn from `placed`. */
  rows: string[];
  placed: Placed[];
  /** The task name set into the top border. */
  title: string;
  /** The note set into the bottom border. */
  message: string;
  width: number;
}

/** The text of a button: its label, then its key hint (when it has one). */
export const cell = (b: Button) => `[ ${b.label}${b.key ? ` · ${b.key}` : ""} ]`;
const clip = (s: string, width: number) => fit(s, width).trimEnd();

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * Lay the panel out for `width` columns inside a rounded frame titled with the task name: one row of
 * buttons with the left group at the left edge and the right group against the right edge (the right
 * group drops to its own row when both do not fit; either group wraps when it is too wide alone),
 * padded to `height` rows, with the message set into the bottom border.
 * Pure, so resizing is just calling it again.
 */
export function layoutTop(snap: TopSnapshot, width: number, height = 0): Frame {
  const inner = Math.max(1, width - 4);
  const content: string[] = [];
  const placed: Placed[] = [];
  const all = buttons(snap);
  const cells = (side: "left" | "right") => all.filter((b) => b.prRow === undefined && (b.side ?? "left") === side).map((button) => ({ button, text: clip(cell(button), inner) }));
  const widthOf = (items: { text: string }[]) => items.reduce((n, i) => n + textWidth(i.text) + 1, 0) - (items.length ? 1 : 0);

  // wrap `items` into rows of at most `inner`, each row starting at `start(rowWidth)`
  const flow = (items: { button: Button; text: string }[], align: "left" | "right", firstRow?: { row: number; used: number }) => {
    let row = firstRow?.row ?? base;
    let line: typeof items = [];
    const flush = () => {
      if (!line.length) return;
      let col = align === "left" ? (row === firstRow?.row ? firstRow.used : 0) : Math.max(0, inner - widthOf(line));
      for (const item of line) {
        placed.push({ button: item.button, row, col, width: textWidth(item.text) });
        col += textWidth(item.text) + 1;
      }
      row++;
      line = [];
    };
    for (const item of items) {
      const base = align === "left" && row === firstRow?.row ? firstRow.used : 0;
      if (line.length && base + widthOf([...line, item]) > inner) flush();
      line.push(item);
    }
    flush();
    return row;
  };

  // one row per PR: the PR first, its actions against the right edge
  let base = 0;
  for (const row of new Set(all.flatMap((b) => (b.prRow === undefined ? [] : [b.prRow])))) {
    const group = all.filter((b) => b.prRow === row);
    const main = group.find((b) => b.side !== "right")!;
    const actions = group.filter((b) => b !== main).map((button) => ({ button, text: clip(cell(button), inner) }));
    const taken = widthOf(actions) + (actions.length ? 2 : 0);
    const text = clip(cell(main), Math.max(1, inner - taken));
    placed.push({ button: main, row: base, col: 0, width: textWidth(text) });
    let col = inner - widthOf(actions);
    for (const a of actions) {
      placed.push({ button: a.button, row: base, col, width: textWidth(a.text) });
      col += textWidth(a.text) + 1;
    }
    base++;
  }

  const left = cells("left");
  const right = cells("right");
  if (left.length && right.length && widthOf(left) + 2 + widthOf(right) <= inner) {
    flow(left, "left");
    flow(right, "right", { row: base, used: 0 });
  } else {
    flow(right, "right", { row: flow(left, "left"), used: 0 });
  }
  const used = Math.max(0, ...placed.map((p) => p.row + 1));
  for (let y = 0; y < Math.max(used, height - 2, 1); y++) {
    let text = "";
    for (const p of placed.filter((q) => q.row === y).sort((a, b) => a.col - b.col)) {
      text += " ".repeat(Math.max(0, p.col - textWidth(text))) + clip(cell(p.button), p.width);
    }
    content.push(text);
  }
  // inside the frame: one row down for the top border, two columns across for the border and padding
  const shifted = placed.map((p) => ({ ...p, row: p.row + 1, col: p.col + 2 }));
  const title = snap.title ?? snap.headline ?? snap.ws;
  const message = snap.message ?? "";
  const rows = [plain(boxTop(title, width)), ...content.map((r) => plain(boxRow(fit(r, inner)))), plain(boxBottom(width, message))];
  return { rows, placed: shifted, title, message, width };
}

/** The button under a 0-based (col,row) cell, if any. */
export function hit(frame: Frame, col: number, row: number): number | undefined {
  const i = frame.placed.findIndex((p) => p.row === row && col >= p.col && col < p.col + p.width);
  return i < 0 ? undefined : i;
}

/**
 * The terminal output that draws `f`: clear, the frame (title bold in the top border, the message in
 * yellow in the bottom one), then each button at its cell, in its colour, inverse under `cursor`.
 */
export function paintTop(f: Frame, cursor: number): string {
  let out = `${ESC}[H${ESC}[2J`;
  const last = f.rows.length - 1;
  const blank = boxRow(" ".repeat(Math.max(1, f.width - 4)));
  f.rows.forEach((_, y) => {
    out += `${ESC}[${y + 1};1H${y === 0 ? boxTop(f.title, f.width) : y === last ? boxBottom(f.width, f.message) : blank}`;
  });
  f.placed.forEach((p, i) => {
    const text = clip(cell(p.button), p.width);
    const shown = i === cursor ? inverse(text) : p.button.color ? colorize(text, p.button.color) : text;
    out += `${ESC}[${p.row + 1};${p.col + 1}H${shown}`;
  });
  return out;
}

export interface ActDeps {
  open: (url: string) => void;
  /** Launch `cmd` detached. */
  spawn: (cmd: string[]) => void;
  start: (app: TopApp) => void;
  stop: (app: TopApp) => void;
  /** Toggle a pane; returns a message for the message row. */
  pane: (pane: PaneKind) => string | undefined;
  /** Wipe the workspace; returns a message for the message row. */
  cleanup: () => string | undefined;
  /** Turn the PR (or its stack) ready for review, or back to draft. */
  ready: (pr: PrInfo, ready: boolean) => string | undefined;
  /** Merge the PR (or its stack); asks for a second press first. */
  merge: (pr: PrInfo) => string | undefined;
}

/** Do what a button says; returns a message for the message row, or undefined. */
export function activate(button: Button, deps: ActDeps): string | undefined {
  const a = button.action;
  switch (a.kind) {
    case "link":
      deps.open(a.url);
      return undefined;
    case "editor":
      deps.spawn([...a.cmd, a.dir]);
      return undefined;
    case "pane":
      return deps.pane(a.pane);
    case "cleanup":
      return deps.cleanup();
    case "ready":
      return deps.ready(a.pr, a.pr.draft);
    case "merge":
      return deps.merge(a.pr);
    case "app": {
      const live = a.app.status === AppStatus.Running || a.app.status === AppStatus.Starting;
      try {
        if (live) deps.stop(a.app);
        else deps.start(a.app);
      } catch (e) {
        return (e as Error).message;
      }
      return undefined;
    }
  }
}

/** `o` on an app button: its URL when it is running. */
export function openTarget(button: Button): string | undefined {
  const a = button.action;
  return a.kind === "app" && a.app.status === AppStatus.Running ? appUrlOf(a.app) : undefined;
}
