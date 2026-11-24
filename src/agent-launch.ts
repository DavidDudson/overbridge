import { isJsonObject, isJsonString, type JsonValue } from "./json";

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

/** overbridge sets these itself; a launch setting may not, or the agent could bind to another workspace. */
export const RESERVED_ENV_PREFIX = "OVERBRIDGE_";

/** Why `name` cannot be a launch env variable, or undefined when it can. */
export function envNameFault(name: string): string | undefined {
  if (!ENV_NAME_RE.test(name)) return "expected a name made of letters, digits and _, not starting with a digit";

  if (name.startsWith(RESERVED_ENV_PREFIX)) return `${RESERVED_ENV_PREFIX}* variables are set by overbridge`;

  return undefined;
}

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
      const fault = cut < 0 ? "expected NAME=VALUE" : envNameFault(name);

      if (fault !== undefined) {
        throw new Error(`--env '${pair}': ${fault}`);
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

/** Whether `l` holds only what `--no-code-mode` and `--chrome` set: all an agent may choose for itself. */
export const onlyShorthands = (l: AgentLaunch): boolean =>
  Object.entries(l.env).every(([k, v]) => k === CODE_MODE_ENV && v === "0") && l.args.every((a) => a === CHROME_ARG);

/** The agent flag that picks its model; Claude Code and agy both take it. */
export const MODEL_ARG = "--model";

/** As a model name, clears the workspace's model, so the agent starts on the root config's or its own default. */
export const DEFAULT_MODEL = "default";

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/;

/** Why `name` cannot be a model name, or undefined when it can; a leading `-` would read as another agent flag. */
export function modelFault(name: string): string | undefined {
  return MODEL_RE.test(name) ? undefined : "expected a model name or alias such as opus or claude-opus-5-5: letters, digits and . _ : / [ ] -, starting with a letter or digit";
}

const MODEL_PREFIX = `${MODEL_ARG}=`;

/** The model `l` sets, if any; the last setting wins. */
export function launchModel(l: AgentLaunch): string | undefined {
  return l.args.flatMap((a, i) => (a === MODEL_ARG ? l.args.slice(i + 1, i + 2) : a.startsWith(MODEL_PREFIX) ? [a.slice(MODEL_PREFIX.length)] : [])).at(-1);
}

/** `l` with its model set to `model`, or with no model when `model` is undefined; every other setting stays. */
export function withModel(l: AgentLaunch, model: string | undefined): AgentLaunch {
  const rest = l.args.filter((a, i) => a !== MODEL_ARG && !a.startsWith(MODEL_PREFIX) && l.args[i - 1] !== MODEL_ARG);

  return { env: l.env, args: [...rest, ...(model === undefined ? [] : [MODEL_ARG, model])] };
}

const sameLaunch = (a: AgentLaunch, b: AgentLaunch): boolean =>
  a.args.length === b.args.length &&
  a.args.every((arg, i) => arg === b.args[i]) &&
  Object.keys(a.env).length === Object.keys(b.env).length &&
  Object.entries(a.env).every(([k, v]) => b.env[k] === v);

/** Whether `next` differs from `current` only in a valid model, which is all `overbridge model` changes. */
export function onlyModelChanged(next: AgentLaunch, current: AgentLaunch): boolean {
  const model = launchModel(next);

  return (model === undefined || modelFault(model) === undefined) && sameLaunch(withModel(next, undefined), withModel(current, undefined));
}

/** Why `v` is not an `AgentLaunch` (stored in state), or undefined when it is one. */
export function launchFault(v: JsonValue | undefined): string | undefined {
  if (!isJsonObject(v)) return "expected a mapping with env and args";

  if (!isJsonObject(v.env) || !Object.entries(v.env).every(([k, val]) => envNameFault(k) === undefined && isJsonString(val))) return "env must map names to strings";

  if (!Array.isArray(v.args) || !v.args.every(isJsonString)) return "args must be a list of strings";

  return undefined;
}
