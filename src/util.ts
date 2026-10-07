export class WsError extends Error {}

export function fail(msg: string): never {
  throw new WsError(msg);
}

export type RunResult = { ok: boolean; code: number; stdout: string; stderr: string };

export function run(cmd: string[], opts: { cwd?: string } = {}): RunResult {
  const p = Bun.spawnSync({ cmd, cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
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
    cwd: opts.cwd,
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

export function log(msg: string) {
  console.error(msg);
}
