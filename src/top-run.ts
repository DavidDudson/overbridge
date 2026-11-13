import { readFileSync } from "node:fs";
import { AppStatus, logPath, openBrowser, startApp, stopApp, waitReady } from "./apps";
import { requireWs } from "./commands";
import { selfCommand } from "./paths";
import { serverRefresh } from "./server-client";
import { beginRemoval } from "./remove";
import { togglePane } from "./panes";
import { mergePr, setReady } from "./pr-actions";
import { ALT_COMMANDS, type ActDeps, activate, applyOptimistic, type PrChange, type Button, CLEANUP_ARM_MS, hit, layoutTop, openTarget, paintTop, pressCleanup, refreshTop, snapshotTop, type TopApp, type TopSnapshot } from "./top";
import { ENTER_SCREEN, LEAVE_SCREEN } from "./term";
import { log, spawnCwd } from "./util";
import { subscribeEvents } from "./events-client";
import { createPainter, isFocused, readView, shouldPoll } from "./zellij-view";

const POLL_MS = 2_000;
const REFRESH_MS = 60_000;
const READY_TIMEOUT_MS = 60_000;

const ESC = "\x1b";

/** `overbridge top refresh [--ws]`: update the cache the panel reads. */
export function topRefresh(wsOpt?: string) {
  const cache = refreshTop(requireWs(wsOpt));
  if (cache.message) log(cache.message);
}

const lastLine = (path: string): string => {
  try {
    return readFileSync(path, "utf8").trimEnd().split("\n").pop() ?? "";
  } catch {
    return "no log yet";
  }
};

/**
 * `overbridge top [--ws]`: the interactive panel. Mouse click or Enter activates a button,
 * arrows/Tab move the cursor, `o` opens a running app, `L` shows its log, `r` refreshes, `q` quits.
 */
export async function topPanel(wsOpt?: string) {
  const ws = requireWs(wsOpt);
  if (!process.stdin.isTTY) throw new Error("overbridge top needs a terminal");

  let snap: TopSnapshot = await snapshotTop(ws);
  let cursor = 0;
  let note: string | undefined;
  let frame = layoutTop(snap, process.stdout.columns ?? 80, process.stdout.rows ?? 0);

  const deps: ActDeps = {
    open: openBrowser,
    run: (command, dir, env) => {
      try {
        Bun.spawn({ cmd: ["sh", "-c", command], cwd: dir, env: { ...process.env, ...env }, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
      } catch (e) {
        note = (e as Error).message;
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
    pane: (pane) => togglePane(ws, pane),
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

  const painter = createPainter((text) => process.stdout.write(text));
  const draw = () => {
    frame = layoutTop({ ...snap, ...(note ? { message: note } : {}) }, process.stdout.columns ?? 80, process.stdout.rows ?? 0);
    painter.paint(paintTop(frame, cursor));
  };

  let lastReloadAtMs = 0;
  let lastRefreshAtMs = 0;
  let liveEvents = () => false;
  const reload = async () => {
    lastReloadAtMs = Date.now();
    snap = await snapshotTop(ws);
    cursor = Math.min(cursor, Math.max(0, frame.placed.length - 1));
    draw();
  };

  /** Rebuild the cache and redraw; `keep` is a message (an action's result) to leave on the message row afterwards. */
  const refresh = (keep?: string, force = false) => {
    lastRefreshAtMs = Date.now();
    note = keep ?? "refreshing…";
    draw();
    void (async () => {
      // through the server when it is up; otherwise a child process rebuilds the cache
      const served = await serverRefresh(ws, { force });
      if (!served) {
        const child = Bun.spawn({ cmd: [...selfCommand(), "top", "refresh", "--ws", ws], cwd: spawnCwd(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
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

  const done = new Promise<void>((resolve) => {
    const quit = () => {
      process.stdout.write(LEAVE_SCREEN);
      process.stdin.setRawMode(false);
      resolve();
    };
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
      if (key === "q" || key === "\x03") return quit();
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
  refresh();
  await done;
  clearInterval(poll);
  events.stop();
}
