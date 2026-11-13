/**
 * A hung server answers nothing, and nothing in it can notice. The watchdog is a worker with its own event loop: the main
 * thread writes a heartbeat into shared memory every second, and the worker (`server-watchdog-worker.ts`) restarts the
 * server when that heartbeat stops for `HUNG_MS`. Imports node builtins only.
 */

/** No heartbeat for this long: the main thread is blocked or dead. Longer than any sync step the server takes. */
export const HUNG_MS = 30_000;
export const BEAT_MS = 1_000;
export const CHECK_MS = 5_000;

export type Verdict = "ok" | "hung" | "slept";

/**
 * Decide from the last heartbeat. When the watchdog's own check ran much later than scheduled the machine was suspended
 * (a closed laptop), which stalls the heartbeat too and is not a hang: the next check judges afresh.
 */
export function watchdogVerdict(o: { beatMs: number; nowMs: number; lastCheckMs: number; hungMs: number; checkMs: number }): Verdict {
  if (o.nowMs - o.lastCheckMs > o.checkMs * 4) return "slept";
  return o.nowMs - o.beatMs >= o.hungMs ? "hung" : "ok";
}

export interface WatchdogOptions {
  /** The process to kill when it hangs. */
  pid?: number;
  /** Started (detached) just before the kill: the command that brings the server back. */
  restart: string[];
  hungMs?: number;
  checkMs?: number;
  /** Tests turn the heartbeat off to simulate a hang. */
  heartbeat?: boolean;
}

/** Start the heartbeat and the watching worker. Returns a stop function. */
export function startWatchdog(o: WatchdogOptions): () => void {
  const beat = new Float64Array(new SharedArrayBuffer(8));
  beat[0] = Date.now();
  const timer = o.heartbeat === false ? undefined : setInterval(() => (beat[0] = Date.now()), BEAT_MS);
  timer?.unref();
  const worker = new Worker(new URL("./server-watchdog-worker.ts", import.meta.url).href);
  worker.postMessage({ beat, pid: o.pid ?? process.pid, restart: o.restart, hungMs: o.hungMs ?? HUNG_MS, checkMs: o.checkMs ?? CHECK_MS });
  return () => {
    if (timer) clearInterval(timer);
    worker.terminate();
  };
}
