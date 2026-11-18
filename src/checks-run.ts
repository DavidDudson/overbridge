import { queueDir, readQueue, ticketName } from "./check-queue";
import { Move, readOrder, writeOrder } from "./check-priority";
import { CHECKS_CHROME, type CheckRow, checkRows, movedOrder, renderChecks } from "./checks";
import { decodeInput, ENTER_SCREEN, frame, LEAVE_SCREEN } from "./term";
import { errorMessage } from "./util";
import { createPainter } from "./zellij-view";

const POLL_MS = 1_000;

const MOVE_KEYS = new Map<string, Move>([
  ["K", Move.Up],
  ["J", Move.Down],
  ["t", Move.Top],
  ["b", Move.Bottom],
]);

/** `overbridge checks`: the pane of the @checks tab. Lists the check queue; K/J/t/b move the selected waiting check. */
export async function checksPane() {
  const dir = queueDir();
  const read = (): CheckRow[] => checkRows(readQueue(dir), readOrder(dir));

  let rows = read();
  let selected = 0;
  let offset = 0;
  let message = "";
  const painter = createPainter((text) => process.stdout.write(text));

  const draw = () => {
    const height = process.stdout.rows ?? 24;
    const width = process.stdout.columns ?? 80;
    selected = Math.min(selected, Math.max(0, rows.length - 1));
    const body = Math.max(1, height - CHECKS_CHROME);

    if (selected < offset) {
      offset = selected;
    }

    if (selected >= offset + body) {
      offset = selected - body + 1;
    }

    painter.paint(frame(renderChecks(rows, { selected, offset, height, width, message, now: Date.now() }), height, width));
  };

  /** Re-read the queue; the cursor stays on the same check while it is queued. */
  const reload = () => {
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

    const next = movedOrder(rows, selected, move, readOrder(dir));

    if (!next) {
      return;
    }

    try {
      writeOrder(dir, next);
    } catch (e) {
      message = `error: could not save the queue order in ${dir}: ${errorMessage(e)}`;
    }

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
      const move = MOVE_KEYS.get(input.key);

      if (input.key === "q" || input.key === "ctrl-c") {
        quit();
      } else if (input.key === "j" || input.key === "down") {
        selected = Math.max(0, Math.min(rows.length - 1, selected + 1));
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
  setInterval(reload, POLL_MS);
  draw();
  await new Promise(() => {});
}
