import type { PrListKind } from "./prlist-data";
import { refreshPrList } from "./prlist-refresh";
import { errorText } from "./server-cache";

/** One PR list refresh off the server's main thread: probe, read in full when it changed, write `prlist-<kind>.json`. */
declare const self: Worker;

self.onmessage = (event: MessageEvent<{ kind: PrListKind; force?: boolean }>) => {
  try {
    postMessage({ ok: true, value: refreshPrList(event.data.kind, Date.now(), undefined, { force: event.data.force === true }) });
  } catch (e) {
    postMessage({ ok: false, error: errorText(e) });
  }
};
