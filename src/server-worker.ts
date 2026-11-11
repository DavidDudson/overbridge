import { errorText } from "./server-cache";
import { refreshTop } from "./top";

/**
 * One top refresh, off the server's main thread: `refreshTop` runs `gh` synchronously, and the server must keep
 * answering while it does. Posts the new cache, or the error text.
 */
declare const self: Worker;

self.onmessage = (event: MessageEvent<{ ws: string }>) => {
  try {
    postMessage({ ok: true, cache: refreshTop(event.data.ws) });
  } catch (e) {
    postMessage({ ok: false, error: errorText(e) });
  }
};
