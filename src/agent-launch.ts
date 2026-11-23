import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonNumber, isJsonObject, isJsonString, numberField, parseJson, stringField, type JsonValue } from "./json";
import { metaDir } from "./paths";

/** Extra environment and arguments a workspace's agent starts with. */
export type AgentLaunch = {
  env: Record<string, string>;
  args: string[];
};

export const EMPTY_LAUNCH: AgentLaunch = { env: {}, args: [] };

/** Set to `0`, it starts Claude Code with Code Mode off. */
export const CODE_MODE_ENV = "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE";

/** Starts Claude Code with Claude in Chrome. */
export const CHROME_ARG = "--chrome";

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether a relaunch resumes the agent's last conversation or starts a new one. */
export const SessionMode = { Continue: "continue", Fresh: "fresh" } as const;

export type SessionMode = (typeof SessionMode)[keyof typeof SessionMode];

/** Later layers win for env; args append in layer order. */
export const mergeLaunch = (...layers: readonly (AgentLaunch | undefined)[]): AgentLaunch =>
  layers.reduce<AgentLaunch>((acc, l) => (l ? { env: { ...acc.env, ...l.env }, args: [...acc.args, ...l.args] } : acc), EMPTY_LAUNCH);

export const isEmptyLaunch = (l: AgentLaunch): boolean => Object.keys(l.env).length === 0 && l.args.length === 0;

/** `KEY=VALUE` pairs as an env map; throws naming the first malformed pair. */
export function parseEnvPairs(pairs: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    pairs.map((pair) => {
      const cut = pair.indexOf("=");
      const name = cut < 0 ? pair : pair.slice(0, cut);

      if (cut < 0 || !ENV_NAME_RE.test(name)) {
        throw new Error(`--env expects NAME=VALUE with NAME made of letters, digits and _ (got '${pair}')`);
      }

      return [name, pair.slice(cut + 1)];
    }),
  );
}

/** What `relaunch`'s shorthand flags and `--env`/`-- args` add up to. */
export interface LaunchFlags {
  noCodeMode?: boolean | undefined;
  chrome?: boolean | undefined;
  env?: readonly string[] | undefined;
  args?: readonly string[] | undefined;
}

export function launchFromFlags(f: LaunchFlags): AgentLaunch {
  const shorthandEnv: [string, string][] = f.noCodeMode ? [[CODE_MODE_ENV, "0"]] : [];

  return {
    env: { ...Object.fromEntries(shorthandEnv), ...parseEnvPairs(f.env ?? []) },
    args: [...(f.chrome ? [CHROME_ARG] : []), ...(f.args ?? [])],
  };
}

/** Whether `l` uses a setting only Claude Code understands. */
export const usesClaudeOnly = (l: AgentLaunch): boolean => CODE_MODE_ENV in l.env || l.args.includes(CHROME_ARG);

/** Why `v` is not an `AgentLaunch` (stored in state), or undefined when it is one. */
export function launchFault(v: JsonValue | undefined): string | undefined {
  if (!isJsonObject(v)) return "expected a mapping with env and args";

  if (!isJsonObject(v.env) || !Object.entries(v.env).every(([k, val]) => ENV_NAME_RE.test(k) && isJsonString(val))) return "env must map names to strings";

  if (!Array.isArray(v.args) || !v.args.every(isJsonString)) return "args must be a list of strings";

  return undefined;
}

/** The running `overbridge claude` supervisor of a workspace and its agent's pid. */
export interface Launcher {
  pid: number;
  child: number;
}

/** What the supervisor does once its agent exits after `overbridge relaunch` asked. */
export interface RelaunchRequest {
  session: SessionMode;
  /** The new agent's first message. */
  prompt: string;
  at: number;
}

/** A request older than this is left over from a relaunch that never happened, and is ignored. */
export const REQUEST_MAX_AGE_MS = 60_000;

/** The signal `relaunch` sends the supervisor (SIGUSR1 can start a debugger in a JS runtime). */
export const RELAUNCH_SIGNAL = "SIGUSR2";

export const launcherPath = (ws: string, meta = metaDir()) => join(meta, "agent", `${ws}.launcher.json`);
export const relaunchRequestPath = (ws: string, meta = metaDir()) => join(meta, "agent", `${ws}.relaunch.json`);

function writeAtomic(file: string, value: Launcher | RelaunchRequest) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value) + "\n");
  renameSync(tmp, file);
}

function readObject(file: string) {
  try {
    const raw = parseJson(readFileSync(file, "utf8"));

    return isJsonObject(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

export const writeLauncher = (ws: string, l: Launcher) => writeAtomic(launcherPath(ws), l);

export function readLauncher(ws: string): Launcher | undefined {
  const raw = readObject(launcherPath(ws));
  const pid = raw && numberField(raw, "pid");
  const child = raw && numberField(raw, "child");

  return pid !== undefined && child !== undefined ? { pid, child } : undefined;
}

/** Remove the launcher file when it still names `pid`, so a newer supervisor's file is never removed. */
export function clearLauncher(ws: string, pid: number) {
  if (readLauncher(ws)?.pid === pid) {
    rmSync(launcherPath(ws), { force: true });
  }
}

export const writeRelaunchRequest = (ws: string, r: RelaunchRequest) => writeAtomic(relaunchRequestPath(ws), r);

/** Parse a stored request; undefined when it is malformed or older than `REQUEST_MAX_AGE_MS`. */
export function parseRelaunchRequest(raw: JsonValue | undefined, now: number): RelaunchRequest | undefined {
  if (!isJsonObject(raw)) return undefined;
  const session = Object.values(SessionMode).find((m) => m === raw.session);
  const prompt = stringField(raw, "prompt");
  const at = isJsonNumber(raw.at) ? raw.at : undefined;

  if (!session || prompt === undefined || at === undefined || now - at > REQUEST_MAX_AGE_MS) return undefined;

  return { session, prompt, at };
}

/** Read and delete the request, so it applies to one restart only. */
export function takeRelaunchRequest(ws: string, now = Date.now()): RelaunchRequest | undefined {
  const file = relaunchRequestPath(ws);
  const raw = readObject(file);
  rmSync(file, { force: true });

  return parseRelaunchRequest(raw, now);
}

/** The agent's extra argv for a relaunch, in the shape `overbridge claude <ws> -- ...` passes on. */
export const relaunchExtra = (r: RelaunchRequest): string[] => [...(r.session === SessionMode.Continue ? ["--continue"] : []), "--", r.prompt];

/** `pid` and its ancestors, nearest first, stopping at pid 1, a loop, or after 64 steps. */
export function ancestry(pid: number, parentOf: (pid: number) => number | undefined): number[] {
  const walk = (p: number | undefined, seen: readonly number[]): number[] =>
    p === undefined || p <= 1 || seen.includes(p) || seen.length >= 64 ? [...seen] : walk(parentOf(p), [...seen, p]);

  return walk(pid, []);
}

/** The workspace whose supervisor is in `chain`: the one a process with that ancestry runs under. */
export const workspaceAbove = (chain: readonly number[], launchers: Readonly<Record<string, Launcher>>): string | undefined =>
  Object.entries(launchers).find(([, l]) => chain.includes(l.pid))?.[0];
