import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { AppStatus, appAvailable, appStatus, appUrl, readRecord } from "./apps";
import * as git from "./git";
import { metaDir, wsDir, worktreePath } from "./paths";
import { providerFor, refreshTitle } from "./pm";
import type { Provider } from "./pm/provider";
import { type AppSpec, type Ide, loadRepoConfig, type ProjectManagement } from "./project-config";
import { getWorkspace, readState } from "./state";
import { bold, dim, inverse } from "./term";
import { run } from "./util";

const ESC = "\x1b";

/**
 * The top panel: a headline, link buttons, an editor button, app toggles and a
 * message row. It renders from `<meta>/top/<ws>.json` and local app records only,
 * never the network; `refreshTop` is what fills the cache.
 */

export interface TopLink {
  label: string;
  url: string;
}

/** What `refreshTop` stores. `message` is the last problem it hit, shown on the message row. */
export interface TopCache {
  headline?: string;
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

export interface TopSnapshot {
  ws: string;
  dir: string;
  headline?: string;
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
          itemLink = { label: id, url: p.link(id) };
        }
      } catch (e) {
        problems.push(`${repo}: ${(e as Error).message}`);
      }
    }
    if (claim.pr !== undefined) {
      const url = exec(["gh", "pr", "view", String(claim.pr), "--json", "url", "--jq", ".url"], dir);
      if (url) links.push({ label: claims.length > 1 ? `${repo} #${claim.pr}` : `PR #${claim.pr}`, url });
      else problems.push(`${repo}: no URL for PR #${claim.pr}`);
      if (exec(["gh", "pr", "view", String(claim.pr), "--json", "state", "--jq", ".state"], dir) === "OPEN") openPrs++;
    }
  }

  const cache: TopCache = {
    // keep the previous values when this run found nothing, so the panel never goes blank on an outage
    ...(headline ?? old.headline ? { headline: headline ?? old.headline } : {}),
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
 * Whether `ws` can be wiped: every claimed branch has an open PR (from the cache) and no repo
 * holds uncommitted changes or unpushed commits (read from git now, so it is never stale).
 */
export function cleanable(ws: string): boolean {
  if (!readTopCache(ws).prsOpen) return false;
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
    links: cache.links,
    ...(ide ? { ide } : {}),
    ...(editor ? { editor } : {}),
    apps,
    ...(cleanable(ws) ? { cleanup: true } : {}),
    ...(problems.length ? { message: problems.join("; ") } : {}),
  };
}

export type Action =
  | { kind: "link"; url: string }
  | { kind: "editor"; cmd: string[]; dir: string }
  | { kind: "app"; app: TopApp }
  | { kind: "cleanup" };

export interface Button {
  label: string;
  action: Action;
}

const MARKS: Record<AppStatus, string> = {
  [AppStatus.Stopped]: "○",
  [AppStatus.Starting]: "◐",
  [AppStatus.Running]: "●",
  [AppStatus.Exited]: "✖",
};

export const appUrlOf = (app: TopApp): string | undefined => appUrl(app.spec, app.port);

/** Split an editor env value like `code -w` (or an ide name like `zed`) into a command and a label. */
function editorFromEnv(editor: string | undefined): { label: string; cmd: string[] } | undefined {
  const cmd = editor?.split(/\s+/).filter(Boolean);
  if (!cmd?.length) return undefined;
  const name = cmd[0]!;
  if (cmd.length === 1 && name in IDE_COMMANDS) return { label: name, cmd: [IDE_COMMANDS[name as Ide]] };
  return { label: basename(name), cmd };
}

/** Buttons in display order: links, editor, apps, then Cleanup when the workspace can be wiped. Apps ruled out by `when:` are left out. */
export function buttons(snap: TopSnapshot): Button[] {
  const out: Button[] = snap.links.map((l) => ({ label: l.label, action: { kind: "link", url: l.url } }));
  const editor = snap.ide ? { label: snap.ide, cmd: [IDE_COMMANDS[snap.ide]] } : editorFromEnv(snap.editor);
  if (editor) out.push({ label: editor.label, action: { kind: "editor", cmd: editor.cmd, dir: snap.dir } });
  for (const app of snap.apps) {
    if (!app.available) continue;
    const port = app.status === AppStatus.Stopped || app.port === undefined ? "" : ` :${app.port}`;
    out.push({ label: `${MARKS[app.status]} ${app.spec.label}${port}`, action: { kind: "app", app } });
  }
  if (snap.cleanup) out.push({ label: "Cleanup", action: { kind: "cleanup" } });
  return out;
}

export interface Placed {
  button: Button;
  /** 0-based row within the panel and 0-based start column. */
  row: number;
  col: number;
  width: number;
}

export interface Frame {
  /** Plain text rows; the cursor is drawn by the caller from `placed`. */
  rows: string[];
  placed: Placed[];
}

const cell = (label: string) => `[ ${label} ]`;
const clip = (s: string, width: number) => (s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s);

/**
 * Lay the panel out for `width` columns: headline row, button rows (wrapping), message row.
 * Pure, so resizing is just calling it again.
 */
export function layoutTop(snap: TopSnapshot, width: number): Frame {
  const rows: string[] = [clip(snap.headline ?? snap.ws, width)];
  const placed: Placed[] = [];
  let line = "";
  const flush = () => {
    if (line) rows.push(line.trimEnd());
    line = "";
  };
  for (const button of buttons(snap)) {
    const text = clip(cell(button.label), width);
    if (line && line.length + text.length > width) flush();
    placed.push({ button, row: rows.length, col: line.length, width: text.length });
    line += `${text} `;
  }
  flush();
  rows.push(clip(snap.message ?? "", width));
  return { rows, placed };
}

/** The button under a 0-based (col,row) cell, if any. */
export function hit(frame: Frame, col: number, row: number): number | undefined {
  const i = frame.placed.findIndex((p) => p.row === row && col >= p.col && col < p.col + p.width);
  return i < 0 ? undefined : i;
}

/**
 * The terminal output that draws `f` with button `cursor` inverse: clear, then each row at its
 * line, the headline bold and the message row dim.
 */
export function paintTop(f: Frame, cursor: number): string {
  let out = `${ESC}[H${ESC}[2J`;
  f.rows.forEach((row, y) => {
    let text = row;
    // paint buttons from the right so earlier columns keep their offsets
    for (const [i, p] of [...f.placed.entries()].reverse()) {
      if (p.row !== y) continue;
      const label = text.slice(p.col, p.col + p.width);
      text = text.slice(0, p.col) + (i === cursor ? inverse(label) : label) + text.slice(p.col + p.width);
    }
    out += `${ESC}[${y + 1};1H${y === 0 ? bold(text) : y === f.rows.length - 1 ? dim(text) : text}`;
  });
  return out;
}

export interface ActDeps {
  open: (url: string) => void;
  /** Launch `cmd` detached. */
  spawn: (cmd: string[]) => void;
  start: (app: TopApp) => void;
  stop: (app: TopApp) => void;
  /** Wipe the workspace; returns a message for the message row. */
  cleanup: () => string | undefined;
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
    case "cleanup":
      return deps.cleanup();
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
