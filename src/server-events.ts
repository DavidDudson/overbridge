/**
 * The server's push channel: `GET /events` is a Server-Sent Events stream of the cache keys that changed. A pane that holds
 * one redraws when its key changes instead of polling for it. The hub is apart from the socket so tests drive it directly.
 */

/** A comment frame every so often: it shows a client the server is alive and lets the server notice a dead one. */
export const HEARTBEAT_MS = 15_000;

/** One change as an SSE frame. */
export const changedFrame = (key: string): string => `event: changed\ndata: ${JSON.stringify({ key })}\n\n`;
export const HEARTBEAT_FRAME = ": ping\n\n";
export const CONNECTED_FRAME = ": connected\n\n";

export type Send = (frame: string) => void;

export function createEvents() {
  const subscribers = new Set<Send>();
  return {
    /** Add a subscriber; returns its unsubscribe. A subscriber whose `send` throws is dropped. */
    subscribe(send: Send): () => void {
      subscribers.add(send);
      return () => void subscribers.delete(send);
    },
    publish(key: string): void {
      const frame = changedFrame(key);
      for (const send of [...subscribers]) {
        try {
          send(frame);
        } catch {
          subscribers.delete(send);
        }
      }
    },
    get count(): number {
      return subscribers.size;
    },
  };
}
export type Events = ReturnType<typeof createEvents>;
