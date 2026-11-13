import { request } from "node:http";
import { CLIENT_START_HEADER, serverDisabled, socketPath, VERSION_HEADER } from "./server-net";
import { overbridgeVersion } from "./version";

/**
 * The pane side of `GET /events`. A pane keeps every poll and file watch it has; this only makes it redraw sooner while the
 * server is up, and lets a hidden pane stop polling. Node builtins plus `server-net.ts` and `version.ts`.
 */

/** No byte (a heartbeat counts) for this long and the server is taken as hung: drop the stream and reconnect. */
export const STALE_STREAM_MS = 45_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface SseFrame {
  event: string;
  data: string;
}

/** Split `buffer` into complete SSE frames (blank-line terminated) and the unfinished rest. Comment lines are skipped. */
export function parseSse(buffer: string): { frames: SseFrame[]; rest: string } {
  const parts = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = parts.pop() ?? "";
  const frames = parts.flatMap((part) => {
    let event = "message";
    const data: string[] = [];
    for (const line of part.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    return data.length ? [{ event, data: data.join("\n") }] : [];
  });
  return { frames, rest };
}

export interface Subscription {
  stop: () => void;
  /** Whether a stream is open right now; a pane polls as it always did when this is false. */
  live: () => boolean;
}

export interface SubscribeOptions {
  onChange: (key: string) => void;
  /** Called when the stream opens (true) or drops (false), so a pane can catch up after a gap. */
  onConnection?: (live: boolean) => void;
  sock?: string;
  staleMs?: number;
  reconnectMinMs?: number;
}

/** Open the event stream and keep it open, reconnecting with backoff. Does nothing when the server is disabled. */
export function subscribeEvents(o: SubscribeOptions): Subscription {
  let live = false;
  let stopped = false;
  let current: { destroy: () => void } | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let backoff = o.reconnectMinMs ?? RECONNECT_MIN_MS;
  const setLive = (v: boolean) => {
    if (live === v) return;
    live = v;
    o.onConnection?.(v);
  };

  function connect() {
    if (stopped || serverDisabled()) return;
    let buffer = "";
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const closeUp = () => {
      if (closed) return;
      closed = true;
      clearTimeout(watchdog);
      setLive(false);
      if (stopped) return;
      retry = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    };
    try {
      const req = request(
        { socketPath: o.sock ?? socketPath(), method: "GET", path: "/events", agent: false, headers: { [VERSION_HEADER]: overbridgeVersion(), [CLIENT_START_HEADER]: String(Date.now() - process.uptime() * 1000), accept: "text/event-stream" } },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            req.destroy();
            return closeUp();
          }
          backoff = o.reconnectMinMs ?? RECONNECT_MIN_MS;
          const arm = () => {
            clearTimeout(watchdog);
            watchdog = setTimeout(() => req.destroy(), o.staleMs ?? STALE_STREAM_MS);
          };
          arm();
          setLive(true);
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            arm();
            const parsed = parseSse(buffer + chunk);
            buffer = parsed.rest;
            for (const f of parsed.frames) {
              if (f.event !== "changed") continue;
              try {
                const key = (JSON.parse(f.data) as { key?: unknown }).key;
                if (typeof key === "string") o.onChange(key);
              } catch {
                // a malformed frame is skipped; the poll covers it
              }
            }
          });
          res.on("end", closeUp);
          res.on("error", closeUp);
          res.on("close", closeUp);
        },
      );
      req.on("error", closeUp);
      current = req;
      req.end();
    } catch {
      closeUp();
    }
  }

  connect();
  return {
    live: () => live,
    stop: () => {
      stopped = true;
      clearTimeout(retry);
      current?.destroy();
      setLive(false);
    },
  };
}
