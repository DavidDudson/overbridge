import { queueDir, readQueue, stopTicket, ticketName } from "./check-queue";
import { Move, readOverrides, readOverridesForWrite, writeOverrides } from "./check-priority";
import { CHECKS_CHROME, type CheckRow, checkRows, ChecksMode, movedOverrides, nextChecksMode, RECENT_WINDOW_MS, type RecentCheck, recentChecks, recentKey, renderChecks, renderRecent } from "./checks";
import { historyStore } from "./history";
import { decodeInput, ENTER_SCREEN, frame, LEAVE_SCREEN, stripControl } from "./term";
import { errorMessage } from "./util";
import { createPainter } from "./zellij-view";

const POLL_MS = 1_000;

/** Reading every workspace's history is heavier than the queue, so the recent view refreshes less often. */
const RECENT_POLL_MS = 5_000;

const MOVE_KEYS = new Map<string, Move>([
  ["K", Move.Up],
  ["J", Move.Down],
  ["t", Move.Top],
  ["b", Move.Bottom],
]);

/** `overbridge checks`: the pane of the @checks tab, over the check queue and the runs that finished recently. */
export async function checksPane() {
  const dir = queueDir();

  /** `fault` is why order.state is ignored, shown until the file reads again. */
  let fault = "";

  const read = (): CheckRow[] => {
    const overrides = (() => {
      try {
        const good = readOverridesForWrite(dir);
        fault = "";

        return good;
      } catch (e) {
        fault = `error: moves are ignored: ${errorMessage(e)}`;

        return readOverrides(dir);
      }
    })();

    return checkRows(readQueue(dir, overrides), overrides);
  };

  const readRecent = (): RecentCheck[] => recentChecks(historyStore(), Date.now() - RECENT_WINDOW_MS);

  let rows = read();
  let recent: RecentCheck[] = [];
  let recentReadMs = 0;
  let mode: ChecksMode = ChecksMode.Queue;
  /** The ticket `x` asked to kill, until `y` confirms or another key cancels. */
  let killing: string | undefined;
  let selected = 0;
  let offset = 0;
  let message = "";

  const listLength = () => (mode === ChecksMode.Queue ? rows.length : recent.length);
  const painter = createPainter((text) => process.stdout.write(text));

  const draw = () => {
    const height = process.stdout.rows ?? 24;
    const width = process.stdout.columns ?? 80;
    selected = Math.min(selected, Math.max(0, listLength() - 1));
    const body = Math.max(1, height - CHECKS_CHROME);

    if (selected < offset) {
      offset = selected;
    }

    if (selected >= offset + body) {
      offset = selected - body + 1;
    }

    const view = { selected, offset, height, width, message: message || fault, now: Date.now() };
    painter.paint(frame(mode === ChecksMode.Queue ? renderChecks(rows, view) : renderRecent(recent, view), height, width));
  };

  /** Re-read the queue; the cursor stays on the same check while it is queued. */
  const reload = () => {
    if (mode === ChecksMode.Recent) {
      const shown = recent[selected];
      recent = readRecent();
      recentReadMs = Date.now();
      const at = shown ? recent.findIndex((r) => recentKey(r) === recentKey(shown)) : -1;

      if (at >= 0) {
        selected = at;
      }

      draw();

      return;
    }

    const current = rows[selected];
    const name = current && ticketName(current.ticket);
    rows = read();
    const at = rows.findIndex((r) => ticketName(r.ticket) === name);

    if (at >= 0) {
      selected = at;
    }

    draw();
  };

  const moveSelected = (move: Move) => {
    const chosen = rows[selected];

    if (chosen?.running) {
      message = "a running check has already started; only waiting checks move";

      return;
    }

    if (rows.some((r) => r.ticket.rank === undefined)) {
      message = "an older overbridge has a check queued, so the queue runs in time order until it leaves";

      return;
    }

    try {
      const next = movedOverrides(rows, selected, move, readOverridesForWrite(dir));

      if (next) {
        writeOverrides(dir, next);
      }
    } catch (e) {
      message = `error: could not save the queue order: ${errorMessage(e)}`;
    }

    reload();
  };

  const describe = (r: CheckRow) => stripControl(`${r.ticket.ws}/${r.ticket.repo}: ${r.ticket.command}`);

  const askKill = () => {
    const chosen = rows[selected];

    if (!chosen) {
      return;
    }

    killing = ticketName(chosen.ticket);
    message = `kill ${describe(chosen)}? y to confirm, any other key cancels`;
  };

  const confirmKill = (name: string) => {
    const chosen = rows.find((r) => ticketName(r.ticket) === name);

    if (!chosen) {
      message = "that check already finished";

      return;
    }

    try {
      stopTicket(chosen.ticket, dir);
      message = `killed ${describe(chosen)}`;
    } catch (e) {
      message = `error: could not kill the check: ${errorMessage(e)}`;
    }

    reload();
  };

  const switchMode = () => {
    mode = nextChecksMode(mode);
    selected = 0;
    offset = 0;
    reload();
  };

  const quit = () => {
    process.stdout.write(LEAVE_SCREEN);
    process.stdin.setRawMode?.(false);
    process.exit(0);
  };

  process.stdout.write(ENTER_SCREEN);
  painter.invalidate();
  process.stdin.setRawMode?.(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data: string) => {
    for (const input of decodeInput(data)) {
      if (input.kind !== "key") {
        continue;
      }

      message = "";
      const move = mode === ChecksMode.Queue ? MOVE_KEYS.get(input.key) : undefined;
      const pending = killing;
      killing = undefined;

      if (input.key === "q" || input.key === "ctrl-c") {
        quit();
      } else if (pending && input.key === "y") {
        confirmKill(pending);
      } else if (input.key === "x" && mode === ChecksMode.Queue) {
        askKill();
      } else if (input.key === "v") {
        switchMode();
      } else if (input.key === "j" || input.key === "down") {
        selected = Math.max(0, Math.min(listLength() - 1, selected + 1));
      } else if (input.key === "k" || input.key === "up") {
        selected = Math.max(0, selected - 1);
      } else if (move) {
        moveSelected(move);
      } else if (input.key === "r") {
        reload();
      }
    }

    draw();
  });
  process.stdout.on("resize", () => {
    painter.invalidate();
    draw();
  });
  setInterval(() => {
    if (mode === ChecksMode.Queue || Date.now() - recentReadMs >= RECENT_POLL_MS) {
      reload();
    }
  }, POLL_MS);
  draw();
  await new Promise(() => {});
}
