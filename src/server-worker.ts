import { isRateLimited } from "./rate-limit";
import { errorText } from "./server-cache";
import { type PrefetchedPrs, type RefreshDeps, refreshTop, type TopCache } from "./top";

/**
 * One top refresh, off the server's main thread: `refreshTop` runs `gh` synchronously, and the server must keep
 * answering while it does. Posts the new cache, or the error text. `limited` carries the first rate-limit failure a `gh`
 * call made on the way, which `refreshTop` itself folds into a missing value, so the server's gate can pause.
 */
declare const self: Worker;

type RefreshReply = { ok: true; cache: TopCache; limited?: string };

self.onmessage = (event: MessageEvent<{ ws: string; prefetched?: PrefetchedPrs; /** Set while `gh` is paused by a rate limit: the last values are kept and this is shown on the message row. */ paused?: string; /** The user's `r`: button `status` commands run even when their last output could be reused. */ force?: boolean }>) => {
  try {
    const { ws, prefetched, paused, force } = event.data;
    let limited: string | undefined;

    const deps: RefreshDeps = {
      prefetched,
      onFailure: (cmd, stderr) => {
        if (!limited && cmd[0] === "gh" && isRateLimited(stderr)) limited = stderr.trim().split("\n")[0];
      },
    };

    if (paused) deps.paused = paused;

    if (force) deps.force = true;
    const cache = refreshTop(ws, deps);
    const reply: RefreshReply = { ok: true, cache };

    if (limited) reply.limited = limited;
    postMessage(reply);
  } catch (e) {
    postMessage({ ok: false, error: errorText(e) });
  }
};
