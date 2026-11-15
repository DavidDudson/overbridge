import { closeSync, openSync, readSync, statSync } from "node:fs";
import { historyFile } from "./history";
import { isJsonObject, numberField, parseJson, stringField } from "./json";

/** One recent tool call. */
export interface ToolCall {
  label: string;
  at: number;
}

/** How much of a history file's end is read for the last few tool calls. */
const TAIL_BYTES = 16 * 1024;

/** Tool names come from the agent's hook payload (an MCP server picks its own): no control characters reach the terminal. */
const label = (tool: string, cls: string | undefined): string => `${tool}${cls && cls !== "other" ? `:${cls}` : ""}`.replace(/[\x00-\x1f\x7f-\x9f]/g, "");

/** The last `n` tool calls in history `text`, newest first. A `PreToolUse` record is one call. */
export function parseToolCalls(text: string, n: number): ToolCall[] {
  const calls: ToolCall[] = [];
  const lines = text.split("\n");

  for (let i = lines.length - 1; i >= 0 && calls.length < n; i--) {
    try {
      const r = parseJson(lines[i]!);

      if (!isJsonObject(r)) continue;
      const tool = stringField(r, "tool");
      const at = numberField(r, "at");

      if (r.kind === "claude" && r.event === "PreToolUse" && tool && at !== undefined) {
        calls.push({ label: label(tool, stringField(r, "cls")), at });
      }
    } catch {
      // a half-written or cut line
    }
  }

  return calls;
}

const cache = new Map<string, { mtimeMs: number; size: number; ino: number; calls: ToolCall[] }>();

/**
 * `ws`'s last `n` tool calls from the end of its history file: one stat per call, a read only when the file changed.
 * No file is no calls; any other read failure throws.
 */
export function recentToolCalls(ws: string, n = 3, file = historyFile(ws)): ToolCall[] {
  let stat;

  try {
    stat = statSync(file);
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return [];
    throw e;
  }

  const { mtimeMs, size, ino } = stat;
  const hit = cache.get(file);

  if (hit && hit.mtimeMs === mtimeMs && hit.size === size && hit.ino === ino) return hit.calls;
  const len = Math.min(size, TAIL_BYTES);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, "r");
  let got = 0;

  try {
    for (let n = 1; n > 0 && got < len; got += n) n = readSync(fd, buf, got, len - got, size - len + got);
  } finally {
    closeSync(fd);
  }

  const text = buf.subarray(0, got).toString("utf8");
  const calls = parseToolCalls(size > len ? text.slice(text.indexOf("\n") + 1) : text, n);
  cache.set(file, { mtimeMs, size, ino, calls });

  return calls;
}
