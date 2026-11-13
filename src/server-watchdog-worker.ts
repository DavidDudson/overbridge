import { watchdogVerdict } from "./server-watchdog";

/** The watchdog's own loop; see `server-watchdog.ts`. It is the one thing that still runs when the main thread does not. */
declare const self: Worker;

self.onmessage = (event: MessageEvent<{ beat: Float64Array; pid: number; restart: string[]; hungMs: number; checkMs: number }>) => {
  const { beat, pid, restart, hungMs, checkMs } = event.data;
  let lastCheckMs = Date.now();
  setInterval(() => {
    const nowMs = Date.now();
    const verdict = watchdogVerdict({ beatMs: beat[0]!, nowMs, lastCheckMs, hungMs, checkMs });
    lastCheckMs = nowMs;
    if (verdict !== "hung") return;
    try {
      // the replacement is already waiting when the hung server dies; it finds the old pid dead and takes over
      Bun.spawn({ cmd: restart, cwd: process.env.HOME ?? "/", stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
    } finally {
      process.kill(pid, "SIGKILL");
    }
  }, checkMs);
};
