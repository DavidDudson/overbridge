import { Action, Keyset, moveSelection, resolve } from "./keys";
import { frozenRows, FROZEN_CHROME, renderFrozen } from "./frozen";
import { selfCommand } from "./paths";
import { tryReadState, watchState } from "./state";
import { decodeInput, ENTER_SCREEN, frame, LEAVE_SCREEN } from "./term";
import { childError, type Finished, type Spawner, spawnAsync } from "./child";
import { errorMessage } from "./util";
import { createPainter } from "./zellij-view";

/** Runs `overbridge thaw <ws>` as a child so the pane keeps drawing; resolves to the pane's next message, empty on success. */
export async function runThaw(ws: string, spawn: Spawner = spawnAsync): Promise<string> {
  const result = await spawn([...selfCommand(), "thaw", ws]).catch((cause: unknown): Finished => ({ code: -1, stderr: `could not run overbridge thaw: ${errorMessage(cause)}` }));

  return result.code === 0 ? "" : `error: ${childError(`overbridge thaw ${ws}`, result)}`;
}

/** `overbridge frozen`: the pane of the @frozen tab. Lists iceboxed workspaces; `t` thaws the selected one. */
export async function frozenPane() {
  const read = () => {
    const { state, fault } = tryReadState();

    return { rows: frozenRows(state), fault };
  };

  const first = read();
  let rows = first.rows;
  let selected = 0;
  let offset = 0;
  // `notice` is the last thaw's outcome; `fault` is why the last state read failed, cleared by the next good one
  let notice = "";
  let fault = first.fault ?? "";
  let busy = false;
  const painter = createPainter((text) => process.stdout.write(text));

  const draw = () => {
    const height = process.stdout.rows ?? 24;
    const width = process.stdout.columns ?? 80;
    selected = Math.min(selected, Math.max(0, rows.length - 1));
    const body = Math.max(1, height - FROZEN_CHROME);

    if (selected < offset) {
      offset = selected;
    }

    if (selected >= offset + body) {
      offset = selected - body + 1;
    }

    const message = !busy && fault ? `error: ${fault}` : notice;
    painter.paint(frame(renderFrozen(rows, { selected, offset, height, width, message, now: Date.now() }), height, width));
  };

  /** Re-read state, keeping the last good rows when the read fails; the cursor stays on the same workspace. */
  const reload = () => {
    const next = read();
    fault = next.fault ?? "";

    if (!next.fault) {
      const ws = rows[selected]?.ws;
      rows = next.rows;
      const moved = rows.findIndex((r) => r.ws === ws);

      if (moved >= 0) {
        selected = moved;
      }
    }

    draw();
  };

  const thawSelected = () => {
    const chosen = rows[selected];

    if (!chosen || busy) {
      return;
    }

    busy = true;
    notice = `thawing ${chosen.ws}…`;
    void runThaw(chosen.ws).then((next) => {
      busy = false;
      notice = next;
      reload();
    });
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

      if (!busy) {
        notice = "";
      }

      const action = resolve(Keyset.frozen, input.key);

      if (action === Action.Quit) {
        quit();
      } else if (action === Action.Down || action === Action.Up || action === Action.Top || action === Action.Bottom) {
        selected = moveSelection(action, selected, rows.length);
      } else if (action === Action.Freeze) {
        thawSelected();
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
  watchState(reload);
  // ages move and a missed watch event is caught here
  setInterval(reload, 30_000);
  draw();
  await new Promise(() => {});
}
