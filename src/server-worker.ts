import { isRateLimited } from "./rate-limit";
import { errorText } from "./server-cache";
import { type PrefetchedPrs, refreshTop } from "./top";

/**
 * One top refresh, off the server's main thread: `refreshTop` runs `gh` synchronously, and the server must keep
 * answering while it does. Posts the new cache, or the error text. `limited` carries the first rate-limit failure a `gh`
 * call made on the way, which `refreshTop` itself folds into a missing value, so the server's gate can pause.
 */
declare const self: Worker;

self.onmessage = (event: MessageEvent<{ ws: string; prefetched?: PrefetchedPrs; /** Set while `gh` is paused by a rate limit: the last values are kept and this is shown on the message row. */ paused?: string }>) => {
  try {
    const { ws, prefetched, paused } = event.data;
    let limited: string | undefined;
    const cache = refreshTop(ws, {
      prefetched,
      ...(paused ? { paused } : {}),
      onFailure: (cmd, stderr) => {
        if (!limited && cmd[0] === "gh" && isRateLimited(stderr)) limited = stderr.trim().split("\n")[0];
      },
    });
    postMessage({ ok: true, cache, ...(limited ? { limited } : {}) });
  } catch (e) {
    postMessage({ ok: false, error: errorText(e) });
  }
};
