import { call, startServer } from "./server-net";

/**
 * Calls the pane, hook and sweep make to the server. Each resolves `undefined` when the server cannot be used (none
 * running, a version mismatch, a failed refresh), and the caller then runs the work itself as it always did.
 */

/** A refresh waits on `gh`, so its ceiling is well above one `gh` call. */
const REFRESH_TIMEOUT_MS = 90_000;

export interface ServerRefresh {
  ws: string;
  served: string;
}

/** Refresh `ws`'s top cache through the server and wait for it; the server writes the same `top/<ws>.json`. */
export async function serverRefresh(ws: string, o: { force?: boolean; sock?: string; start?: boolean } = {}): Promise<ServerRefresh | undefined> {
  const r = await call("POST", `/refresh/top/${encodeURIComponent(ws)}${o.force ? "?force=1" : ""}`, { timeoutMs: REFRESH_TIMEOUT_MS, ...(o.sock ? { sock: o.sock } : {}) });
  if (!r && o.start !== false) startServer();
  if (!r || r.status !== 200) return undefined;
  try {
    return JSON.parse(r.body) as ServerRefresh;
  } catch {
    return undefined;
  }
}

/** Refresh several workspaces through the server together; it caps how many run at once. */
export async function serverRefreshAll(workspaces: string[], o: { sock?: string } = {}): Promise<void> {
  await Promise.all(workspaces.map((ws) => serverRefresh(ws, o)));
}
