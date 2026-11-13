import { errorText } from "./server-cache";
import { type PrefetchedPrs, refreshTop } from "./top";

/**
 * One top refresh, off the server's main thread: `refreshTop` runs `gh` synchronously, and the server must keep
 * answering while it does. Posts the new cache, or the error text.
 */
declare const self: Worker;

self.onmessage = (event: MessageEvent<{ ws: string; prefetched?: PrefetchedPrs; /** Set while `gh` is paused by a rate limit: the last values are kept and this is shown on the message row. */ paused?: string }>) => {
  try {
    const { ws, prefetched, paused } = event.data;
    postMessage({ ok: true, cache: refreshTop(ws, { prefetched, ...(paused ? { paused } : {}) }) });
  } catch (e) {
    postMessage({ ok: false, error: errorText(e) });
  }
};
