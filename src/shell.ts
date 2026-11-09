import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { shellCacheDir } from "./paths";
import type { ShellSpec } from "./project-config";
import { fail, log } from "./util";

/** A command ready to spawn: where, with what env. */
export interface ShellInvocation {
  cmd: string[];
  cwd: string;
  /** Overlaid on the caller's env. */
  env: Record<string, string>;
}

export type Env = Record<string, string>;

/** Parse NUL-separated `KEY=VALUE` pairs, as `env -0` prints them. Entries without `=` are dropped. */
export function parseEnv0(text: string): Env {
  const env: Env = {};
  for (const entry of text.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/** Set by whichever shell ran the capture, not by the dev env. */
const SESSION_VARS = ["PWD", "OLDPWD", "SHLVL", "_"];

/** The variables of `after` that are new or changed against `before`, minus the capturing shell's own. */
export function envDiff(before: Record<string, string | undefined>, after: Env): Env {
  return Object.fromEntries(Object.entries(after).filter(([k, v]) => before[k] !== v && !SESSION_VARS.includes(k)));
}

/**
 * The cache key for a repo's resolved env: the worktree, the shell config and the contents of every `key`
 * file (a missing file hashes as absent, so creating it invalidates too).
 */
export function cacheKey(dir: string, spec: ShellSpec, read: (file: string) => string | undefined): string {
  const h = createHash("sha256");
  h.update(JSON.stringify([dir, spec.enter, spec.env ?? null]));
  for (const file of spec.key) h.update(`\0${file}\0${read(join(dir, file)) ?? "\0missing"}`);
  return h.digest("hex").slice(0, 16);
}

const readIfExists = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : undefined);

export interface ShellDeps {
  /** Run the spec's `env` command in `dir`; its stdout. */
  capture: (command: string, dir: string) => string;
  read: (file: string) => string | undefined;
  cacheDir: () => string;
  /** The env the capture is diffed against. */
  base: () => Record<string, string | undefined>;
  /** Whether `command` is on PATH. */
  has: (command: string) => boolean;
  warn: (msg: string) => void;
}

const defaultDeps = (): ShellDeps => ({
  capture: (command, dir) => {
    const r = Bun.spawnSync({ cmd: ["sh", "-c", command], cwd: dir, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    if (r.exitCode !== 0) fail(`shell.env \`${command}\` failed in ${dir}:\n${r.stderr.toString().trim()}`);
    return r.stdout.toString();
  },
  read: readIfExists,
  cacheDir: shellCacheDir,
  base: () => process.env,
  has: (command) => Bun.which(command) !== null,
  warn: log,
});

/**
 * The resolved dev env of `repo` in worktree `dir`: from the cache when the key files are unchanged, else
 * captured with `spec.env` and stored. Only variables that differ from the caller's env are kept, so the
 * capture's own TERM, PWD and SHLVL do not leak into later commands.
 */
export function resolveEnv(repo: string, dir: string, spec: ShellSpec, deps: ShellDeps = defaultDeps()): Env {
  if (!spec.env) return {};
  const file = join(deps.cacheDir(), `${repo}-${cacheKey(dir, spec, deps.read)}.json`);
  const hit = deps.read(file);
  if (hit !== undefined) {
    try {
      return JSON.parse(hit) as Env;
    } catch {
      // a torn or hand-edited file: capture again
    }
  }
  const env = envDiff(deps.base(), parseEnv0(deps.capture(spec.env, dir)));
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(env));
  renameSync(tmp, file);
  return env;
}

/** Shell keywords, builtins and `env`: always there, so a command starting with one is not checked. */
const SHELL_WORDS = new Set(["if", "case", "for", "while", "until", "{", "(", "!", ".", "source", "exec", "command", "eval", "env", "test", "["]);

/**
 * The program a shell command starts, skipping leading `VAR=value` assignments; undefined when it starts with
 * a shell keyword or builtin, or is empty.
 */
export function leadingProgram(command: string): string | undefined {
  const word = command.trim().split(/\s+/).find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  return word && !SHELL_WORDS.has(word) ? word : undefined;
}

/** Run `inner` through `enter`, in `cwd`: the prefix runs where the repo's config lives, then the command moves to `cwd`. */
const through = (enter: string, dir: string, cwd: string, inner: string[]): ShellInvocation => ({
  cmd: ["sh", "-c", `${enter} sh -c 'cd "$1" && shift && exec "$@"' sh "$@"`, "overbridge-shell", cwd, ...inner],
  cwd: dir,
  env: {},
});

/**
 * How to run `argv` in `cwd` inside the repo's dev shell. With a cached env the command runs directly with
 * it; otherwise it goes through the `enter` prefix. No `shell` means the command runs as it is, and so does a
 * shell whose program (nix, direnv, ...) is not on PATH, with a warning: the repo's tools may still be there.
 */
export function shellInvocation(
  repo: string,
  dir: string,
  spec: ShellSpec | undefined,
  argv: string[],
  cwd = dir,
  deps: ShellDeps = defaultDeps(),
): ShellInvocation {
  if (!spec) return { cmd: argv, cwd, env: {} };
  const program = leadingProgram(spec.env ?? spec.enter);
  if (program && !deps.has(program)) {
    deps.warn(`${program} not on PATH; running without ${repo}'s dev shell`);
    return { cmd: argv, cwd, env: {} };
  }
  if (spec.env) return { cmd: argv, cwd, env: resolveEnv(repo, dir, spec, deps) };
  return through(spec.enter, dir, cwd, argv);
}
