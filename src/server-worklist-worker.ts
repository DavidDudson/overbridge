import { errorText } from "./server-cache";
import { type BoardSource, planWorklist, readSource } from "./worklist-data";

/** One work-list job off the server's main thread: plan the reads (git shows) or run one board read (`gh`/`jira`). */
declare const self: Worker;

self.onmessage = (event: MessageEvent<{ kind: "plan" } | { kind: "read"; source: BoardSource }>) => {
  try {
    const m = event.data;
    postMessage({ ok: true, value: m.kind === "plan" ? planWorklist() : readSource(m.source) });
  } catch (e) {
    postMessage({ ok: false, error: errorText(e) });
  }
};
