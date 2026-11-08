import { readFileSync } from "node:fs";
import { AppStatus, logPath, openBrowser, startApp, stopApp, waitReady } from "./apps";
import { requireWs } from "./commands";
import { selfCommand } from "./paths";
import { type ActDeps, activate, type Button, hit, layoutTop, openTarget, refreshTop, snapshotTop, type TopApp, type TopSnapshot } from "./top";
import { log } from "./util";

const POLL_MS = 2_000;
const REFRESH_MS = 60_000;
const READY_TIMEOUT_MS = 60_000;

const ESC = "\x1b";
const REVERSE = `${ESC}[7m`;
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;

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
  };
  const snapUrl = (app: TopApp) => {
    const port = app.port ?? "";
    return app.spec.ready?.kind === "http" ? app.spec.ready.url.replaceAll("{port}", String(port)) : "";
  };

  const draw = () => {
    frame = layoutTop({ ...snap, ...(note ? { message: note } : {}) }, process.stdout.columns ?? 80);
    let out = `${ESC}[H${ESC}[2J`;
    frame.rows.forEach((row, y) => {
      let text = row;
      // paint buttons from the right so earlier columns keep their offsets
      for (const [i, p] of [...frame.placed.entries()].reverse()) {
        if (p.row !== y) continue;
        const label = text.slice(p.col, p.col + p.width);
        text = text.slice(0, p.col) + (i === cursor ? `${REVERSE}${label}${RESET}` : label) + text.slice(p.col + p.width);
      }
      out += `${ESC}[${y + 1};1H${y === 0 ? BOLD : y === frame.rows.length - 1 ? DIM : ""}${text}${RESET}`;
    });
    process.stdout.write(out);
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
      process.stdout.write(`${ESC}[?1000l${ESC}[?1006l${ESC}[?25h${ESC}[?1049l`);
      process.stdin.setRawMode(false);
      resolve();
    };
    process.stdout.write(`${ESC}[?1049h${ESC}[?25l${ESC}[?1000h${ESC}[?1006h`);
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
