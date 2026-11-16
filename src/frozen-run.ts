import { frozenRows, FROZEN_CHROME, renderFrozen } from "./frozen";
import { selfCommand } from "./paths";
import { tryReadState, watchState } from "./state";
import { decodeInput, ENTER_SCREEN, frame, LEAVE_SCREEN } from "./term";
import { childError, type Finished, type Spawner, spawnAsync } from "./child";
import { errorMessage } from "./util";

/**
 * Run `overbridge thaw <ws>` as a child, so the pane keeps drawing while worktrees come back. The child inherits the
 * session's environment, so it opens the workspace's tab. Resolves to the pane's next message: empty on success.
 */
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

  let rows = read().rows;
  let selected = 0;
  let offset = 0;
  let message = "";
  let busy = false;

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

    process.stdout.write(frame(renderFrozen(rows, { selected, offset, height, width, message, now: Date.now() }), height, width));
  };

  /** Re-read state; the cursor stays on the same workspace when the list moves under it. */
  const reload = () => {
    const ws = rows[selected]?.ws;
    const next = read();
    rows = next.rows;
    const moved = rows.findIndex((r) => r.ws === ws);

    if (moved >= 0) {
      selected = moved;
    }

    if (!busy && next.fault) {
      message = `error: ${next.fault}`;
    }

    draw();
  };

  const thawSelected = () => {
    const chosen = rows[selected];

    if (!chosen || busy) {
      return;
    }

    busy = true;
    message = `thawing ${chosen.ws}…`;
    void runThaw(chosen.ws).then((next) => {
      busy = false;
      message = next;
      reload();
    });
  };

  const quit = () => {
    process.stdout.write(LEAVE_SCREEN);
    process.stdin.setRawMode?.(false);
    process.exit(0);
  };

  process.stdout.write(ENTER_SCREEN);
  process.stdin.setRawMode?.(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data: string) => {
    for (const input of decodeInput(data)) {
      if (input.kind !== "key") {
        continue;
      }

      if (input.key === "q" || input.key === "ctrl-c") {
        quit();
      } else if (input.key === "j" || input.key === "down") {
        selected = Math.max(0, Math.min(rows.length - 1, selected + 1));
      } else if (input.key === "k" || input.key === "up") {
        selected = Math.max(0, selected - 1);
      } else if (input.key === "t") {
        thawSelected();
      } else if (input.key === "r") {
        reload();
      }
    }

    draw();
  });
  process.stdout.on("resize", draw);
  watchState(reload);
  // ages move and a missed watch event is caught here
  setInterval(reload, 30_000);
  draw();
  await new Promise(() => {});
}
