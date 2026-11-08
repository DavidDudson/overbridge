import { readFileSync } from "node:fs";
import { AppStatus, logPath, openBrowser, startApp, stopApp, waitReady } from "./apps";
import { requireWs } from "./commands";
import { root, selfCommand } from "./paths";
import { type ActDeps, activate, type Button, CLEANUP_ARM_MS, cleanable, hit, layoutTop, openTarget, paintTop, pressCleanup, refreshTop, snapshotTop, type TopApp, type TopSnapshot } from "./top";
import { ENTER_SCREEN, LEAVE_SCREEN } from "./term";
import { log, run } from "./util";

const POLL_MS = 2_000;
const REFRESH_MS = 60_000;
const READY_TIMEOUT_MS = 60_000;

const ESC = "\x1b";

/** `overbridge top refresh [--ws]`: update the cache the panel reads. */
export function topRefresh(wsOpt?: string) {
  const cache = refreshTop(requireWs(wsOpt));
  if (cache.message) log(cache.message);
}

/**
 * Wipe `ws` once its Cleanup is confirmed. Re-reads everything first (PR state from the network,
 * git state from disk) and refuses on any doubt, then stops its apps, runs a non-force `rm`
 * (which itself refuses uncommitted changes) and closes this tab. Returns the message to show.
 */
function wipe(ws: string, apps: TopApp[]): string | undefined {
  refreshTop(ws);
  if (!cleanable(ws)) return `${ws} is no longer clean (open PR, nothing uncommitted or unpushed); not wiping`;
  try {
    for (const app of apps) if (app.status === AppStatus.Running || app.status === AppStatus.Starting) stopApp(ws, app.repo, app.spec, app.repoDir);
  } catch (e) {
    return `not wiping ${ws}: ${(e as Error).message}`;
  }
  const rm = Bun.spawnSync({ cmd: [...selfCommand(), "rm", ws], cwd: root(), stdout: "ignore", stderr: "pipe" });
  if (rm.exitCode !== 0) return rm.stderr.toString().trim() || `rm ${ws} failed`;
  // closes the focused tab, which is this one: the press came from here
  if (process.env.ZELLIJ) run(["zellij", "action", "close-tab"], { cwd: root() });
  return `wiped ${ws}`;
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
  let frame = layoutTop(snap, process.stdout.columns ?? 80);

  const deps: ActDeps = {
    open: openBrowser,
    spawn: (cmd) => {
      try {
        Bun.spawn({ cmd, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
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
    cleanup: () => {
      const press = pressCleanup(armedAt, Date.now());
      armedAt = press.armedAt;
      return press.confirmed ? wipe(ws, snap.apps) : `press Cleanup again within ${CLEANUP_ARM_MS / 1000}s to wipe ${ws}`;
    },
  };
  let armedAt: number | undefined;
  const snapUrl = (app: TopApp) => {
    const port = app.port ?? "";
    return app.spec.ready?.kind === "http" ? app.spec.ready.url.replaceAll("{port}", String(port)) : "";
  };

  const draw = () => {
    frame = layoutTop({ ...snap, ...(note ? { message: note } : {}) }, process.stdout.columns ?? 80);
    process.stdout.write(paintTop(frame, cursor));
  };

  const reload = async () => {
    snap = await snapshotTop(ws);
    cursor = Math.min(cursor, Math.max(0, frame.placed.length - 1));
    draw();
  };

  const refresh = () => {
    note = "refreshing…";
    draw();
    const self = selfCommand();
    const child = Bun.spawn({ cmd: [...self, "top", "refresh", "--ws", ws], stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    void child.exited.then(async () => {
      note = undefined;
      await reload();
    });
  };

  const current = (): Button | undefined => frame.placed[cursor]?.button;
  const act = async (button: Button | undefined) => {
    if (!button) return;
    note = activate(button, deps) ?? note;
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
      if (key === `${ESC}[C` || key === "l" || key === "\t") cursor = n ? (cursor + 1) % n : 0;
      else if (key === `${ESC}[D` || key === "h" || key === `${ESC}[Z`) cursor = n ? (cursor + n - 1) % n : 0;
      else if (key === "\r" || key === " ") return void act(current());
      else if (key === "r") return refresh();
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
    process.stdout.on("resize", draw);
  });

  draw();
  const poll = setInterval(() => void reload(), POLL_MS);
  const timer = setInterval(refresh, REFRESH_MS);
  refresh();
  await done;
  clearInterval(poll);
  clearInterval(timer);
}
