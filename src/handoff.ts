import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wsDir } from "./paths";

export const HandoffReason = { Context: "context", Manual: "manual", Icebox: "icebox" } as const;
export type HandoffReason = (typeof HandoffReason)[keyof typeof HandoffReason];

export interface HandoffRow {
  repo: string;
  branch: string;
  head: string;
  pr?: number | undefined;
}

export interface HandoffInput {
  ws: string;
  reason: HandoffReason;
  next: string;
  rows: HandoffRow[];
}

/** A handoff in the format `read-handoff` reads (see `plugin/skills/read-handoff/HANDOFF-FORMAT.md`). */
export function renderHandoff(h: HandoffInput): string {
  const table = h.rows.map((r) => `| ${r.repo} | ${r.branch || "-"} | ${r.head || "-"} | none |`);
  const prs = h.rows.filter((r) => r.pr).map((r) => `- ${r.repo}: PR #${r.pr} on \`${r.branch}\``);
  return [
    `# Handoff: ${h.ws} paused`,
    "",
    `Next: ${h.next}`,
    `Reason: ${h.reason}`,
    `Workspace: ${h.ws}`,
    "",
    "## State",
    "",
    "| Repo | Branch | HEAD | Uncommitted |",
    "| --- | --- | --- | --- |",
    ...table,
    ...(prs.length ? ["", "## In progress", "", ...prs] : []),
    "",
  ].join("\n");
}

/** `YYYYMMDD-HHMM` in UTC, so file names sort in time order. */
export const handoffStamp = (d: Date) => d.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");

export const handoffDir = (ws: string) => join(wsDir(ws), ".overbridge", "handoffs");

/** Write the handoff and return its path. */
export function writeHandoff(h: HandoffInput, now = new Date()): string {
  const dir = handoffDir(h.ws);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${handoffStamp(now)}-${h.reason}.md`);
  writeFileSync(file, renderHandoff(h));
  return file;
}
