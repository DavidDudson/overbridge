import { dirname } from "node:path";
import { queueDir, readQueue, stopTicket, ticketName } from "./check-queue";
import { Move, readOverrides, readOverridesForWrite, writeOverrides } from "./check-priority";
import { CHECKS_CHROME, type CheckRow, checkRows, ChecksMode, queueEstimates, type QueueEstimates, movedOverrides, nextChecksMode, RECENT_WINDOW_MS, type RecentCheck, recentChecks, recentKey, renderChecks, renderRecent } from "./checks";
import { readEstimates, seedEstimates, seedRuns } from "./check-estimate";
import { historyStore } from "./history";
import { Action, Keyset, moveSelection, resolve } from "./keys";
import { decodeInput, ENTER_SCREEN, frame, LEAVE_SCREEN, stripControl } from "./term";
import { errorMessage } from "./util";
import { createPainter } from "./zellij-view";

const POLL_MS = 1_000;

/** Reading every workspace's history is heavier than the queue, so the recent view refreshes less often. */
const RECENT_POLL_MS = 5_000;

const SEED_WINDOW_MS = 7 * 24 * 60 * 60_000;

const MOVE_KEYS = new Map<string, Move>([
  ["K", Move.Up],
  ["J", Move.Down],
  ["T", Move.Top],
  ["B", Move.Bottom],
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

    const queue = readQueue(dir, overrides);
    estimates = queueEstimates(queue, readEstimates(dirname(dir)), Date.now());

    return checkRows(queue, overrides);
  };

  const readRecent = (): RecentCheck[] => recentChecks(historyStore(), Date.now() - RECENT_WINDOW_MS);

  // a store from before this build: build it from the last week of history once
  seedEstimates(dirname(dir), seedRuns(recentChecks(historyStore(), Date.now() - SEED_WINDOW_MS, Number.POSITIVE_INFINITY)));

  let estimates: QueueEstimates = { etas: new Map(), wsDoneMs: new Map() };
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
    painter.paint(frame(mode === ChecksMode.Queue ? renderChecks(rows, view, estimates) : renderRecent(recent, view), height, width));
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

      const action = resolve(mode === ChecksMode.Queue ? Keyset.checksQueue : Keyset.checksRecent, input.key);

      if (action === Action.Quit) {
        quit();
      } else if (pending && input.key === "y") {
        confirmKill(pending);
      } else if (action === Action.Delete) {
        askKill();
      } else if (action === Action.View) {
        switchMode();
      } else if (action === Action.Down || action === Action.Up || action === Action.Top || action === Action.Bottom) {
        selected = moveSelection(action, selected, listLength());
      } else if (move) {
        moveSelected(move);
      } else if (action === Action.Refresh) {
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
