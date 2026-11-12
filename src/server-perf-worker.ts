import { refreshPerf } from "./perf-cache";
import { errorText } from "./server-cache";

/** One rebuild of `perf.json`, off the server's main thread. Posts when the views were built, or the error text. */
declare const self: Worker;

self.onmessage = () => {
  try {
    postMessage({ ok: true, at: refreshPerf().at });
  } catch (e) {
    postMessage({ ok: false, error: errorText(e) });
  }
};
