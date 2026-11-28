import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, watch } from "node:fs";
import { join } from "node:path";
import { PRESS_KEYS } from "./keys";
import { metaDir } from "./paths";
import { defaultMux, type Mux } from "./mux";
import { OverbridgeError } from "./util";

/**
 * `overbridge top press <key>`: press a button of the top panel from outside it, so a chord bound in the
 * multiplexer works while Claude has the keyboard. The press goes through a file, `<meta>/top-press/<tab>`, one
 * `<ms> <key>` line each, which the panel of that tab watches and empties. A line older than `PRESS_MAX_AGE_MS` is
 * dropped, so a press made while no panel ran never fires later.
 */
export const PRESS_MAX_AGE_MS = 3_000;

export const PRESS_USAGE = "usage: overbridge top press <key> [--ws name]";

const pressDir = () => join(metaDir(), "top-press");

/** The keys a press may carry: a button key of the panel, listed once in `keys.ts` for the tmux and zellij bindings too. */
export const isPressKey = (key: string): boolean => PRESS_KEYS.includes(key);

/** The keys in `text` that are fresh at `now`. Pure. */
export function parsePresses(text: string, now: number, maxAgeMs = PRESS_MAX_AGE_MS): string[] {
  const keys: string[] = [];

  for (const line of text.split("\n")) {
    const m = /^(\d+) (.)$/.exec(line);

    if (m && now - Number(m[1]) <= maxAgeMs && isPressKey(m[2]!)) keys.push(m[2]!);
  }

  return keys;
}

/** Queue `key` for the panel of tab `tab`. */
export function pressKey(tab: string, key: string, now = Date.now()): void {
  if (!isPressKey(key)) throw new OverbridgeError(`'${key}' is not a button key; ${PRESS_USAGE}`);
  mkdirSync(pressDir(), { recursive: true });
  appendFileSync(join(pressDir(), tab), `${now} ${key}\n`);
}

/** Take the fresh presses queued for `tab`, emptying the queue. A rename claims the file, so two readers never both act on a line. */
export function drainPresses(tab: string, now = Date.now()): string[] {
  const file = join(pressDir(), tab);
  const taken = `${file}.${process.pid}.taken`;

  try {
    renameSync(file, taken);
  } catch {
    return [];
  }

  try {
    return parsePresses(readFileSync(taken, "utf8"), now);
  } catch {
    return [];
  } finally {
    rmSync(taken, { force: true });
  }
}

/** Call `onKey` for each press queued for `tab`, soon after it is written; returns a stop function. */
export function watchPresses(tab: string, onKey: (key: string) => void): () => void {
  mkdirSync(pressDir(), { recursive: true });

  const run = () => {
    for (const key of drainPresses(tab)) onKey(key);
  };

  const watcher = watch(pressDir(), (_event, filename) => {
    if (filename === tab) run();
  });

  // a missed watch event is caught here
  const poll = setInterval(run, 2_000);

  return () => {
    clearInterval(poll);
    watcher.close();
  };
}

/** `overbridge top press <key>`: the tab is `--ws`, else the multiplexer's current tab. */
export function topPress(key: string | undefined, wsOpt: string | undefined, mux: Pick<Mux, "currentTab"> = defaultMux()): void {
  if (!key) throw new OverbridgeError(PRESS_USAGE);
  const tab = wsOpt ?? mux.currentTab();

  if (!tab) throw new OverbridgeError("not on a tab; pass --ws");
  pressKey(tab, key);
}
