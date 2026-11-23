import { splitCommand } from "./guard-orchestrator";

/** Finds an `overbridge check` command that runs the whole suite instead of what the branch changed. */

export const ScopeRule = {
  RunManyAll: "run-many-all",
  RunManyTooMany: "run-many-too-many",
  AffectedAll: "affected-all",
  UnscopedTest: "unscoped-test",
  SkipCache: "skip-cache",
} as const;

export type ScopeRule = (typeof ScopeRule)[keyof typeof ScopeRule];

export interface ScopeRefusal {
  rule: ScopeRule;
  /** Why the run is unscoped, naming the words that make it so. */
  reason: string;
  /** The nx target, when the command names one; it fills in the suggested `nx affected`. */
  target?: string;
}

const TEST_TARGETS = new Set(["test", "test:unit"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const RUNNERS = new Set(["npx", "pnpx", "bunx"]);
const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const EXEC_SUBCOMMANDS = new Set(["exec", "dlx", "x"]);
const TEST_RUNNERS = new Set(["vitest", "jest"]);

/** Package manager flags that take the next word as their value (pnpm's `-w` is a switch, so it is not here). */
const PM_VALUE_FLAGS = new Set(["-C", "--dir", "--prefix", "--filter", "-F", "--cwd", "--workspace"]);

/** Programs that run the rest of their words as a command, with the flags that take a value and how many positionals come first. */
const PREFIXES = new Map<string, { valueFlags: ReadonlySet<string>; positionals: number }>([
  ["time", { valueFlags: new Set(), positionals: 0 }],
  ["command", { valueFlags: new Set(), positionals: 0 }],
  ["exec", { valueFlags: new Set(["-a"]), positionals: 0 }],
  ["nohup", { valueFlags: new Set(), positionals: 0 }],
  ["nice", { valueFlags: new Set(["-n"]), positionals: 0 }],
  ["timeout", { valueFlags: new Set(["-s", "-k", "--signal", "--kill-after"]), positionals: 1 }],
  ["xargs", { valueFlags: new Set(["-I", "-n", "-P", "-L", "-d", "-E", "-s"]), positionals: 0 }],
]);

const MAX_UNWRAP_DEPTH = 8;
const SKIP_CACHE = /^--skip-?nx-?cache(?:=(?!false$).*)?$/i;
const SKIP_CACHE_ENV = /^NX_SKIP_NX_CACHE=(?!false$|0$|$)/i;
const SPEC_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/;
const SCOPED_TEST_FLAG = /^--(?:changed|related|onlyChanged|findRelatedTests|testFile|testPathPattern)(?:=|$)|^-o$/;
const PROJECTS_FLAG = /^(?:-p|--projects)(?:=(.*))?$/;
const TARGETS_FLAG = /^(?:-t|--targets?)(?:=(.*))?$/;

const basename = (word: string) => word.split("/").pop() ?? word;
const isAssignment = (word: string) => /^[A-Za-z_]\w*=/.test(word);

/**
 * `cmd` split into simple commands. splitCommand refuses redirects and substitutions, so those are retried with the
 * redirects dropped and each substitution split out as its own command, and split on spaces as a last resort.
 */
function segmentsOf(cmd: string): string[][] {
  const split = splitCommand(cmd);

  if ("segments" in split) {
    return split.segments;
  }

  const flattened = cmd.replace(/\$\(|[<>]\(|`|\)/g, " ; ").replace(/\d*(?:>>?|<)&?\s*[^\s;&|()]+/g, " ");
  const retried = splitCommand(flattened);

  if ("segments" in retried) {
    return retried.segments;
  }

  return flattened
    .split(/&&|\|\||;|\||\n/)
    .map((part) => part.trim().split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, "")).filter(Boolean))
    .filter((words) => words.length > 0);
}

interface SplitEnv {
  env: string[];
  rest: string[];
}

/** `words` without its leading `VAR=value` assignments and `env` wrapper; the assignments come back in `env`. */
function stripEnv(words: readonly string[]): SplitEnv {
  const start = words.findIndex((w) => !isAssignment(w));
  const lead = start < 0 ? [...words] : words.slice(0, start);
  const rest = start < 0 ? [] : words.slice(start);

  if (basename(rest[0] ?? "") !== "env") {
    return { env: lead, rest };
  }

  const at = firstPositional(rest, 1, new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]));
  const inner = stripEnv(rest.slice(at));

  return { env: [...lead, ...inner.env], rest: inner.rest };
}

function firstPositional(words: readonly string[], from: number, valueFlags: ReadonlySet<string>): number {
  const at = words.slice(from).findIndex((w, i, rest) => {
    const previous = i > 0 ? rest[i - 1] : undefined;

    return !w.startsWith("-") && !(previous !== undefined && valueFlags.has(previous));
  });

  return at < 0 ? words.length : from + at;
}

interface Invocation {
  env: string[];
  program: string;
  args: string[];
  /** A package script (`pnpm test`) rather than a binary. */
  isPackageScript: boolean;
}

/** Every command `argv` runs, unwrapped from shells, env prefixes, runners, package managers and prefixes such as `timeout`. */
export function invocations(argv: readonly string[], depth = 0): Invocation[] {
  const { env, rest } = stripEnv(argv);
  const program = basename(rest[0] ?? "");
  const unwrap = (words: readonly string[]) => invocations([...env, ...words], depth + 1);

  if (!program || depth > MAX_UNWRAP_DEPTH) {
    return [];
  }

  if (SHELLS.has(program)) {
    const flag = rest.findIndex((w, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(w));
    const shellScript = flag < 0 ? undefined : rest[flag + 1];

    return shellScript === undefined ? [] : segmentsOf(shellScript).flatMap(unwrap);
  }

  const prefix = PREFIXES.get(program);

  if (prefix) {
    const at = firstPositional(rest, 1, prefix.valueFlags);

    return unwrap(rest.slice(at + prefix.positionals));
  }

  if (RUNNERS.has(program)) {
    return unwrap(rest.slice(firstPositional(rest, 1, new Set(["-p", "--package"]))));
  }

  if (PACKAGE_MANAGERS.has(program)) {
    return packageManagerCalls(program, env, rest, unwrap);
  }

  return [{ env, program, args: rest.slice(1), isPackageScript: false }];
}

function packageManagerCalls(program: string, env: string[], rest: readonly string[], unwrap: (words: readonly string[]) => Invocation[]): Invocation[] {
  const at = firstPositional(rest, 1, PM_VALUE_FLAGS);
  const sub = rest[at];

  if (sub === undefined) {
    return [];
  }

  if (EXEC_SUBCOMMANDS.has(sub)) {
    return unwrap(rest.slice(firstPositional(rest, at + 1, PM_VALUE_FLAGS)));
  }

  // `yarn workspace <name> <script>` runs the script in one package
  if (program === "yarn" && sub === "workspace") {
    return unwrap([program, ...rest.slice(at + 2)]);
  }

  if (sub === "run" || sub === "run-script") {
    const nameAt = firstPositional(rest, at + 1, PM_VALUE_FLAGS);
    const name = rest[nameAt];

    return name === undefined ? [] : [packageCall(env, name, rest.slice(nameAt + 1))];
  }

  // `bun test` is bun's own runner, not a script
  if (program === "bun" && sub === "test") {
    return [{ env, program: "bun test", args: rest.slice(at + 1), isPackageScript: false }];
  }

  return [packageCall(env, sub, rest.slice(at + 1))];
}

/** `pnpm nx …` runs the nx binary and `pnpm vitest …` the runner; any other name is a package script. */
function packageCall(env: string[], name: string, args: string[]): Invocation {
  return { env, program: name, args, isPackageScript: name !== "nx" && !TEST_RUNNERS.has(name) };
}

/** The values of a list flag (`-p a,b`, `-p a b`, `--projects=a,b`), split on commas; undefined when the flag is absent. */
function flagValues(args: readonly string[], flag: RegExp): string[] | undefined {
  const lists = args.flatMap((w, i) => {
    const m = flag.exec(w);

    if (!m) {
      return [];
    }

    if (m[1] !== undefined) {
      return [[m[1]]];
    }

    const tail = args.slice(i + 1);
    const end = tail.findIndex((x) => x.startsWith("-"));

    return [end < 0 ? tail : tail.slice(0, end)];
  });

  return lists.length ? lists.flat().flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean) : undefined;
}

/** A path that names a spec file or a folder below the project root; `.` and `./` are the whole project. */
function isNarrowPath(word: string): boolean {
  const trimmed = word.replace(/^\.\//, "").replace(/\/+$/, "");

  return SPEC_FILE.test(word) || (word.includes("/") && trimmed !== "" && trimmed !== ".");
}

/** A test run narrowed to changed files, related files, or named spec files or folders. */
function testScoped(args: readonly string[]): boolean {
  return args.some((w, i) => {
    const previous = i > 0 ? args[i - 1] : undefined;
    const isFlagValue = previous !== undefined && /^-[^=]*$/.test(previous) && !SPEC_FILE.test(w);

    return SCOPED_TEST_FLAG.test(w) || w === "related" || (!w.startsWith("-") && !isFlagValue && isNarrowPath(w));
  });
}

const unscopedTestRefusal = (what: string, target: string): ScopeRefusal => ({
  rule: ScopeRule.UnscopedTest,
  reason: `${what} runs every test`,
  target,
});

function runManyRefusal(args: readonly string[], maxProjects: number, targets: readonly string[]): ScopeRefusal | undefined {
  const target = targets[0] ?? "<target>";
  const projects = flagValues(args, PROJECTS_FLAG);

  if (!projects?.length || args.includes("--all")) {
    return { rule: ScopeRule.RunManyAll, reason: "nx run-many with no -p/--projects runs every project", target };
  }

  const pattern = projects.find((p) => p.includes("*") || p.startsWith("tag:"));

  if (pattern !== undefined) {
    return { rule: ScopeRule.RunManyTooMany, reason: `nx run-many -p ${pattern} is a pattern that can match any number of projects`, target };
  }

  if (projects.length > maxProjects) {
    return { rule: ScopeRule.RunManyTooMany, reason: `nx run-many -p lists ${projects.length} projects, over the cap of ${maxProjects} (check-scope.max-projects)`, target };
  }

  const test = targets.find((t) => TEST_TARGETS.has(t));

  return test && !testScoped(args) ? unscopedTestRefusal(`nx run-many -t ${test}`, test) : undefined;
}

function nxRefusal(args: readonly string[], maxProjects: number): ScopeRefusal | undefined {
  const sub = args[firstPositional(args, 0, new Set())];
  const targets = flagValues(args, TARGETS_FLAG) ?? [];

  if (sub === "run-many") {
    return runManyRefusal(args, maxProjects, targets);
  }

  // `affected:test` is the older spelling of `affected -t test`
  if (sub === "affected" || sub?.startsWith("affected:")) {
    const target = targets[0] ?? sub.split(":")[1] ?? "<target>";

    return args.includes("--all") ? { rule: ScopeRule.AffectedAll, reason: "nx affected --all runs every project", target } : undefined;
  }

  // `nx run app:test` and `nx test app`
  const runTarget = sub === "run" ? args[firstPositional(args, args.indexOf("run") + 1, new Set())] : undefined;
  const named = runTarget === undefined ? sub : runTarget.split(":").slice(1).join(":");

  return named && TEST_TARGETS.has(named) && !testScoped(args) ? unscopedTestRefusal(`nx ${named}`, named) : undefined;
}

function callRefusal(call: Invocation, maxProjects: number): ScopeRefusal | undefined {
  const skip = call.args.find((w) => SKIP_CACHE.test(w)) ?? call.env.find((w) => SKIP_CACHE_ENV.test(w));

  if (skip) {
    return { rule: ScopeRule.SkipCache, reason: `${skip} turns off the nx cache, so every project runs again` };
  }

  if (call.program === "nx") {
    return nxRefusal(call.args, maxProjects);
  }

  if (call.isPackageScript) {
    return TEST_TARGETS.has(call.program) && !testScoped(call.args) ? unscopedTestRefusal(`the ${call.program} script`, call.program) : undefined;
  }

  if (TEST_RUNNERS.has(call.program)) {
    return testScoped(call.args) ? undefined : unscopedTestRefusal(call.program, "test");
  }

  return undefined;
}

/**
 * Why `argv` is not scoped to the branch's changes, or undefined when it is. `inherited` is the environment the
 * command starts with, read for `NX_SKIP_NX_CACHE`. Best effort: it reads common forms, not every shell construct.
 */
export function scopeRefusal(argv: readonly string[], maxProjects: number, inherited: Readonly<Record<string, string | undefined>> = {}): ScopeRefusal | undefined {
  const skip = inherited.NX_SKIP_NX_CACHE;

  if (skip !== undefined && SKIP_CACHE_ENV.test(`NX_SKIP_NX_CACHE=${skip}`)) {
    return { rule: ScopeRule.SkipCache, reason: `NX_SKIP_NX_CACHE=${skip} in the environment turns off the nx cache, so every project runs again` };
  }

  return invocations(argv)
    .map((call) => callRefusal(call, maxProjects))
    .find((r) => r !== undefined);
}

/** Why `command` is unscoped and what to run instead; `headline` is the first line. */
export function refusalMessage(headline: string, refusal: ScopeRefusal): string {
  const target = refusal.target ?? "<target>";

  return [
    headline,
    `  ${refusal.reason}.`,
    "CI runs the full suite, so scope the check to what the branch changed, such as:",
    `  nx affected -t ${target} --base=origin/<base>`,
    "  vitest run --changed origin/<base>",
    "  the same test command with --changed origin/<base> (after -- for a package script), --related <file> or spec file paths",
    "where <base> is the PR's base branch (the stack base on a stacked layer, else the default branch).",
  ].join("\n");
}
