import { call, startServer } from "./server-net";

/**
 * Calls the pane and the sweep make to the server. Each resolves `undefined` when the server cannot be used (none
 * running, a version mismatch, an unknown workspace), and the caller then runs the work itself.
 */

/** A refresh waits on `gh`; this is longer than the server's own worker timeout, so a slow refresh is never run twice. */
const REFRESH_TIMEOUT_MS = 130_000;

export interface ServerRefresh {
  ws: string;
  /** How the server answered: `fresh`, `shared`, `hit` or `stale`. */
  served: string;
  /** Set when the refresh failed: the server tried, so the caller must not hit `gh` again on its own. */
  error?: string;
}

/** Refresh `ws`'s top cache through the server and wait for it; the server writes the same `top/<ws>.json`. */
export async function serverRefresh(ws: string, o: { force?: boolean; sock?: string; start?: boolean } = {}): Promise<ServerRefresh | undefined> {
  const r = await call("POST", `/refresh/top/${encodeURIComponent(ws)}${o.force ? "?force=1" : ""}`, { timeoutMs: REFRESH_TIMEOUT_MS, ...(o.sock ? { sock: o.sock } : {}) });
  if (!r && o.start !== false) startServer();
  // 502 is a refresh that failed on the server: its backoff applies, so a fallback `gh` storm would defeat it
  if (!r || (r.status !== 200 && r.status !== 502)) return undefined;
  try {
    const body = JSON.parse(r.body) as { ws?: string; served?: string; error?: string };
    return { ws, served: body.served ?? "failed", ...(body.error ? { error: body.error } : {}) };
  } catch {
    return undefined;
  }
}

/** Refresh several workspaces through the server together; it caps how many run at once. Resolves the ones it could not take. */
export async function serverRefreshAll(workspaces: string[], o: { sock?: string; start?: boolean } = {}): Promise<string[]> {
  const results = await Promise.all(workspaces.map(async (ws) => ((await serverRefresh(ws, o)) ? undefined : ws)));
  return results.filter((ws): ws is string => ws !== undefined);
}
