import { readFileSync } from "node:fs";
import { AppStatus, logPath, openBrowser, startApp, stopApp, waitReady } from "./apps";
import { requireWs } from "./commands";
import { selfCommand } from "./paths";
import { serverRefresh } from "./server-client";
import { beginRemoval } from "./remove";
import { togglePane } from "./panes";
import { mergePr, setReady } from "./pr-actions";
import { ALT_COMMANDS, type ActDeps, activate, applyOptimistic, type PaneKind, type PrChange, type Button, CLEANUP_ARM_MS, hit, layoutTop, openTarget, paintTop, pressCleanup, refreshTop, snapshotTop, type TopApp, type TopScope, type TopSnapshot, topRowsNeeded } from "./top";
import { afterStep, type FitState, planFit, settle } from "./top-fit";
import { TOP_ROWS } from "./layout";
import { defaultMux } from "./mux";
import { ENTER_SCREEN, LEAVE_SCREEN } from "./term";
import { errorMessage, log, spawnCwd } from "./util";
import { subscribeEvents } from "./events-client";
import { createPainter, isFocused, readView, shouldPoll } from "./zellij-view";

const POLL_MS = 2_000;
const REFRESH_MS = 60_000;
const READY_TIMEOUT_MS = 60_000;

/** How long the pane waits after a resize step before it reads its new height. */
const FIT_SETTLE_MS = 300;

const ESC = "\x1b";

/** `overbridge top refresh [--ws] [--force]`: update the cache the panel reads; `force` reruns button `status` commands. */
export function topRefresh(wsOpt?: string, force = false) {
  const cache = refreshTop(requireWs(wsOpt), { force });

  if (cache.message) log(cache.message);
}

const lastLine = (path: string): string => {
  try {
    return readFileSync(path, "utf8").trimEnd().split("\n").pop() ?? "";
  } catch {
    return "no log yet";
  }
};

/** A panel over something other than a workspace (the @explore tab): no PR cache to refresh, its own scope and panes. */
export interface PanelOptions {
  /** The name apps and the cache are kept under. */
  name: string;
  scope: TopScope;
  /** Label of the button that leaves the panel. */
  back: string;
  pane: (pane: PaneKind) => string | undefined;
  /** Shown on the message row when the panel opens. */
  message?: string;
  /** Called once with a function that puts a message on the message row, for work that finishes later. */
  onMessage?: (show: (message: string) => void) => void;
}

/** How a panel ended: its back button, or `q` / Ctrl-C. */
export const PanelExit = { Back: "back", Quit: "quit" } as const;

export type PanelExit = (typeof PanelExit)[keyof typeof PanelExit];

/**
 * `overbridge top [--ws]`: the interactive panel. Mouse click or Enter activates a button,
 * arrows/Tab move the cursor, `o` opens a running app, `L` shows its log, `r` refreshes, `q` quits.
 * With `panel` it draws that scope instead and never refreshes the PR cache; `b` (or its button) leaves.
 */
export async function topPanel(wsOpt?: string, panel?: PanelOptions): Promise<PanelExit> {
  const ws = panel ? panel.name : requireWs(wsOpt);

  if (!process.stdin.isTTY) throw new Error("overbridge top needs a terminal");

  const snapshot = async (): Promise<TopSnapshot> => {
    const s = await snapshotTop(ws, process.env, panel?.scope);

    return panel ? { ...s, back: panel.back } : s;
  };

  let snap: TopSnapshot = await snapshot();

  let leave = (_exit: PanelExit) => {};

  /** Set once the panel quits, so a reload still in flight draws nothing over what comes next. */
  let hasLeft = false;
  let cursor = 0;
  let note: string | undefined;
  let frame = layoutTop(snap, process.stdout.columns ?? 80, process.stdout.rows ?? 0);

  const deps: ActDeps = {
    open: openBrowser,
    run: (command, dir, env) => {
      try {
        Bun.spawn({ cmd: ["sh", "-c", command], cwd: dir, env: { ...process.env, ...env }, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
      } catch (e) {
        note = errorMessage(e);
      }
    },
    spawn: (cmd) => {
      try {
        const head = cmd[0]!;
        const alt = ALT_COMMANDS[head];
        const resolved = !Bun.which(head) && alt && Bun.which(alt) ? [alt, ...cmd.slice(1)] : cmd;
        Bun.spawn({ cmd: resolved, cwd: spawnCwd(), stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
      } catch {
        note = `${cmd[0]} is not installed`;
      }
    },
    start: (app: TopApp) => {
      const record = startApp(ws, app.repo, app.spec, app.repoDir);

      if (app.spec.ready) {
        void waitReady(app.spec, record, READY_TIMEOUT_MS).then((ok) => {
          if (ok && app.spec.open) openBrowser(snapUrl(app));
        });
      }
    },
    stop: (app: TopApp) => void stopApp(ws, app.repo, app.spec, app.repoDir),
    pane: (pane) => (panel ? panel.pane(pane) : togglePane(ws, pane)),
    back: () => {
      leave(PanelExit.Back);

      return undefined;
    },
    ready: (pr, ready) => {
      showNow({ kind: "ready", pr, ready });

      return setReady(pr, ready);
    },
    merge: (pr) => {
      const press = pressCleanup(mergeArmed.get(pr.number), Date.now());

      if (press.armedAt === undefined) mergeArmed.delete(pr.number);
      else mergeArmed.set(pr.number, press.armedAt);

      if (press.confirmed) showNow({ kind: "merge", pr });

      return press.confirmed ? mergePr(pr) : `press Merge again within ${CLEANUP_ARM_MS / 1000}s to merge ${pr.stack.length > 1 ? "the stack" : `PR #${pr.number}`}`;
    },
    cleanup: () => {
      const press = pressCleanup(armedAt, Date.now());
      armedAt = press.armedAt;

      return press.confirmed ? (beginRemoval(ws) ?? `removing ${ws}…`) : `press Cleanup again within ${CLEANUP_ARM_MS / 1000}s to wipe ${ws}`;
    },
  };

  let armedAt: number | undefined;
  const mergeArmed = new Map<number, number>();
  /** Set when a press ran a PR action, so `act` refetches at once instead of waiting for the timer. */
  let ranPrAction = false;

  /** Paint the expected result before the blocking `gh` call; the refetch that follows corrects it if the call failed. */
  const showNow = (change: PrChange) => {
    ranPrAction = true;
    snap = applyOptimistic(snap, change);
    draw();
  };

  const snapUrl = (app: TopApp) => {
    const port = app.port ?? "";

    return app.spec.ready?.kind === "http" ? app.spec.ready.url.replaceAll("{port}", String(port)) : "";
  };

  const mux = defaultMux();
  // a workspace's top pane grows to show every level of its work item; the @explore panel keeps its layout's height
  const ownPaneId = panel ? undefined : mux.ownPaneId();
  let fit: FitState = {};
  let isFitStepping = false;

  /** Take one resize step towards the height `shown` needs, then look again once the multiplexer has applied it. */
  const fitHeight = (shown: TopSnapshot) => {
    const rows = process.stdout.rows ?? 0;

    // a hidden tab's pane may not resize, which would read as no room left
    if (!ownPaneId || isFitStepping || !rows || !isFocused(ws, readView())) {
      return;
    }

    const needed = Math.max(TOP_ROWS, topRowsNeeded(shown, process.stdout.columns ?? 80));
    const step = planFit(rows, needed, fit);

    if (!step) {
      fit = settle(fit, needed);

      return;
    }

    // with focus unknown (outside zellij) a step that changes nothing may be a hidden tab, not a full one
    const record = (after: number) => {
      fit = after === rows && readView().focused !== ws ? fit : afterStep(fit, rows, after, needed);
    };

    if (!mux.resizePane(ownPaneId, step)) {
      record(rows);

      return;
    }

    isFitStepping = true;
    setTimeout(() => {
      isFitStepping = false;
      record(process.stdout.rows ?? rows);
      draw();
    }, FIT_SETTLE_MS);
  };

  const painter = createPainter((text) => process.stdout.write(text));

  const draw = () => {
    if (hasLeft) return;
    const shown: TopSnapshot = { ...snap };

    if (note) shown.message = note;
    frame = layoutTop(shown, process.stdout.columns ?? 80, process.stdout.rows ?? 0);
    painter.paint(paintTop(frame, cursor));
    fitHeight(shown);
  };

  let lastReloadAtMs = 0;
  let lastRefreshAtMs = 0;
  let liveEvents = () => false;

  const reload = async () => {
    lastReloadAtMs = Date.now();
    snap = await snapshot();
    cursor = Math.min(cursor, Math.max(0, frame.placed.length - 1));
    draw();
  };

  /** Rebuild the cache and redraw; `keep` is a message (an action's result) to leave on the message row afterwards. */
  const refresh = (keep?: string, force = false) => {
    lastRefreshAtMs = Date.now();

    if (panel) {
      note = keep;

      return void reload();
    }

    note = keep ?? "refreshing…";
    draw();
    void (async () => {
      // through the server when it is up; otherwise a child process rebuilds the cache
      const served = await serverRefresh(ws, { force });

      if (!served) {
        const child = Bun.spawn({ cmd: [...selfCommand(), "top", "refresh", "--ws", ws, ...(force ? ["--force"] : [])], cwd: spawnCwd(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        await child.exited;
      }

      note = served?.error ? `refresh failed: ${served.error}` : keep;
      await reload();
    })();
  };

  /** A refresh that must show a change just made (a PR action, the `r` key): never answered from the cache. */
  const forceRefresh = (keep?: string) => refresh(keep, true);

  const current = (): Button | undefined => frame.placed[cursor]?.button;

  const act = async (button: Button | undefined) => {
    if (!button) return;
    ranPrAction = false;
    note = activate(button, deps) ?? note;

    if (ranPrAction) return forceRefresh(note);
    await Bun.sleep(150);
    await reload();
  };

  const done = new Promise<PanelExit>((resolve) => {
    const quit = (exit: PanelExit = PanelExit.Quit) => {
      hasLeft = true;
      // a caller may draw in this process next, so the panel stops listening to the terminal before it resolves
      process.stdin.removeAllListeners("data");
      process.stdout.removeAllListeners("resize");
      process.stdout.write(LEAVE_SCREEN);
      process.stdin.setRawMode(false);
      resolve(exit);
    };

    leave = quit;

    process.stdout.write(ENTER_SCREEN);
    painter.invalidate();
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (buf) => {
      const key = buf.toString();
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(key);

      if (mouse) {
        // left-button press only
        if (mouse[1] === "0" && mouse[4] === "M") {
          const i = hit(frame, Number(mouse[2]) - 1, Number(mouse[3]) - 1);

          if (i !== undefined) {
            cursor = i;
            void act(current());
          }
        }

        return;
      }

      note = undefined;
      const n = frame.placed.length;

      if (key === "q" || key === "\x03") return quit(PanelExit.Quit);
      const byKey = key.length === 1 ? frame.placed.findIndex((p) => p.button.key === key) : -1;

      if (byKey >= 0) {
        cursor = byKey;

        return void act(current());
      }

      if (key === `${ESC}[C` || key === "l" || key === "\t") cursor = n ? (cursor + 1) % n : 0;
      else if (key === `${ESC}[D` || key === "h" || key === `${ESC}[Z`) cursor = n ? (cursor + n - 1) % n : 0;
      else if (key === "\r" || key === " ") return void act(current());
      else if (key === "r") return forceRefresh();
      else if (key === "o") {
        const url = current() && openTarget(current()!);

        if (url) openBrowser(url);
        else note = "select a running app to open it";
      } else if (key === "L") {
        const a = current()?.action;
        note = a?.kind === "app" && a.app.status !== AppStatus.Stopped ? `${logPath(ws, a.app.repo, a.app.spec.id)}: ${lastLine(logPath(ws, a.app.repo, a.app.spec.id))}` : "select an app to see its log";
      }

      draw();
    });
    process.stdout.on("resize", () => {
      painter.invalidate();
      draw();
    });
  });

  draw();

  // a hidden tab's panel reloads only every HIDDEN_POLL_MS and leaves the git and gh refresh until its tab is focused
  const tick = () => {
    const view = readView();
    const nowMs = Date.now();

    if (isFocused(ws, view) && nowMs - lastRefreshAtMs >= REFRESH_MS) {
      refresh();
    } else if (shouldPoll(ws, view, lastReloadAtMs, nowMs, liveEvents())) {
      void reload();
    }
  };

  const poll = setInterval(tick, POLL_MS);

  // the server says when this workspace's cache changed, so the panel reloads at once and a hidden one stops polling
  const events = subscribeEvents({
    onChange: (key) => {
      if (key === `top:${ws}`) void reload();
    },
    onConnection: (up) => {
      if (up) void reload();
    },
  });

  liveEvents = events.live;
  refresh(panel?.message);

  panel?.onMessage?.((message) => {
    note = message;
    draw();
  });

  const exit = await done;
  clearInterval(poll);
  events.stop();

  return exit;
}
