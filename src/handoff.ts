import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as git from "./git";
import { worktreePath, wsDir } from "./paths";
import { getWorkspace, readState } from "./state";

/** The first message of an agent that starts from a handoff (`thaw`, `relaunch`). */
export const THAW_PROMPT = "/read-handoff";

/** Read the handoff, then carry out `prompt` in place of the handoff's Next line when one is given. */
export const thawFirstMessage = (prompt?: string): string => (prompt ? `${THAW_PROMPT} --then ${prompt}` : THAW_PROMPT);

export const HandoffReason = { Context: "context", Manual: "manual", Icebox: "icebox", Relaunch: "relaunch" } as const;

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

/** Each claim of `ws` with its worktree's HEAD, as a handoff's State table lists them. */
export function handoffRows(ws: string): HandoffRow[] {
  return Object.entries(getWorkspace(readState(), ws).repos).map(([repo, c]) => ({
    repo,
    branch: c.branch ?? "",
    head: git.headSha(worktreePath(ws, repo))?.slice(0, 7) ?? "",
    pr: c.pr,
  }));
}

/** Write the handoff and return its path. */
export function writeHandoff(h: HandoffInput, now = new Date()): string {
  const dir = handoffDir(h.ws);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${handoffStamp(now)}-${h.reason}.md`);
  writeFileSync(file, renderHandoff(h));

  return file;
}
