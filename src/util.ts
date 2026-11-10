import { existsSync } from "node:fs";
import { homedir } from "node:os";

export class OverbridgeError extends Error {}

export function fail(msg: string): never {
  throw new OverbridgeError(msg);
}

export type RunResult = { ok: boolean; code: number; stdout: string; stderr: string };

/**
 * The cwd to spawn a child in: `cwd` when given, else this process's cwd while it still exists, else home.
 * A long-lived pane (sidebar, top) keeps the cwd of a workspace that `rm` deleted, and posix_spawn then
 * fails with ENOENT on every child.
 */
export function spawnCwd(cwd?: string): string {
  if (cwd) return cwd;
  try {
    const here = process.cwd();
    if (existsSync(here)) return here;
  } catch {
    // Linux: process.cwd() throws once the directory is gone (macOS returns the stale path)
  }
  return homedir();
}

export function run(cmd: string[], opts: { cwd?: string } = {}): RunResult {
  const p = Bun.spawnSync({ cmd, cwd: spawnCwd(opts.cwd), stdout: "pipe", stderr: "pipe" });
  return {
    ok: p.exitCode === 0,
    code: p.exitCode ?? 1,
    stdout: p.stdout.toString().trim(),
    stderr: p.stderr.toString().trim(),
  };
}

/** Run a command, failing with its stderr if it exits non-zero. Returns trimmed stdout. */
export function must(cmd: string[], opts: { cwd?: string } = {}): string {
  const r = run(cmd, opts);
  if (!r.ok) fail(`\`${cmd.join(" ")}\` failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
}

/** Run a command attached to the terminal and return its exit code. */
export function exec(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): number {
  const p = Bun.spawnSync({
    cmd,
    cwd: spawnCwd(opts.cwd),
    env: { ...process.env, ...opts.env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return p.exitCode ?? 1;
}

export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

export const naturalSort = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** A plain object: what a JSON mapping parses to. */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What `v` is, for an error about a value that should have been something else: `null`, `an array`, `a number`. */
export function describeValue(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return `a ${typeof v}`;
}

/** The message of whatever was thrown; a non-Error throw is stringified. */
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function log(msg: string) {
  console.error(msg);
}
