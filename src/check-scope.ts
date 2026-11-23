import { splitCommand } from "./guard-orchestrator";

/**
 * Refuses an `overbridge check` command that runs the whole suite instead of what the branch changed: `nx run-many`
 * over every project (or more than `max-projects`), `nx affected --all`, a `test`/`test:unit` target or vitest/jest
 * run with no `--changed`, `--related` or spec path, and `--skip-nx-cache`. It looks through env prefixes, `sh -c`,
 * `npx`, `pnpm exec`, `pnpm dlx` and package scripts, since an agent reaches the same run through any of them.
 */

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

/** Package manager flags that take the next word as their value. */
const PM_VALUE_FLAGS = new Set(["-C", "--dir", "--prefix", "--filter", "-F", "--cwd", "--workspace", "-w"]);
const SKIP_CACHE = /^--skip-?nx-?cache(?:=(?!false$).*)?$/i;
const SPEC_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/;
const SCOPED_TEST_FLAG = /^--(?:changed|related|onlyChanged|findRelatedTests|testFile|testPathPattern)(?:=|$)|^-o$/;

const basename = (word: string) => word.split("/").pop() ?? word;
const isAssignment = (word: string) => /^[A-Za-z_]\w*=/.test(word);

/** `cmd` split into simple commands; a command splitCommand refuses (a redirect, a substitution) is split on operators and spaces. */
function segmentsOf(cmd: string): string[][] {
  const split = splitCommand(cmd);

  if ("segments" in split) {
    return split.segments;
  }

  return cmd
    .split(/&&|\|\||;|\||\n/)
    .map((part) => part.trim().split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, "")).filter(Boolean))
    .filter((words) => words.length > 0);
}

/** A command's leading `VAR=value` assignments, apart from the words that run. */
interface SplitEnv {
  env: string[];
  rest: string[];
}

/** `words` without its leading `VAR=value` assignments and `env` wrapper; the assignments come back separately. */
function stripEnv(words: readonly string[]): SplitEnv {
  const start = words.findIndex((w) => !isAssignment(w));
  const lead = start < 0 ? [...words] : words.slice(0, start);
  const rest = start < 0 ? [] : words.slice(start);

  if (basename(rest[0] ?? "") !== "env") {
    return { env: lead, rest };
  }

  const options = rest.slice(1).findIndex((w) => !w.startsWith("-"));
  const inner = stripEnv(options < 0 ? [] : rest.slice(1 + options));

  return { env: [...lead, ...inner.env], rest: inner.rest };
}

/** The first index at or after `from` that is not a flag (or a value flag's value). */
function firstPositional(words: readonly string[], from: number, valueFlags: ReadonlySet<string>): number {
  const at = words.slice(from).findIndex((w, i, rest) => !w.startsWith("-") && !(i > 0 && valueFlags.has(rest[i - 1]!)));

  return at < 0 ? words.length : from + at;
}

/** A command the scope rules read: the program (`nx`, a test runner, or a package script) and its arguments. */
interface Invocation {
  env: string[];
  program: string;
  args: string[];
  /** A package script (`pnpm test`) rather than a binary. */
  script: boolean;
}

/** Every command `argv` runs, unwrapped from shells, env prefixes, runners and package managers. */
export function invocations(argv: readonly string[], depth = 0): Invocation[] {
  const { env, rest } = stripEnv(argv);
  const program = basename(rest[0] ?? "");

  if (!program || depth > 8) {
    return [];
  }

  if (SHELLS.has(program)) {
    const flag = rest.findIndex((w, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(w));
    const script = flag < 0 ? undefined : rest[flag + 1];

    return script === undefined ? [] : segmentsOf(script).flatMap((words) => invocations([...env, ...words], depth + 1));
  }

  if (RUNNERS.has(program)) {
    const at = firstPositional(rest, 1, new Set(["-p", "--package"]));

    return invocations([...env, ...rest.slice(at)], depth + 1);
  }

  if (PACKAGE_MANAGERS.has(program)) {
    const at = firstPositional(rest, 1, PM_VALUE_FLAGS);
    const sub = rest[at];

    if (sub === undefined) {
      return [];
    }

    if (EXEC_SUBCOMMANDS.has(sub)) {
      return invocations([...env, ...rest.slice(firstPositional(rest, at + 1, PM_VALUE_FLAGS))], depth + 1);
    }

    if (sub === "run" || sub === "run-script") {
      const name = firstPositional(rest, at + 1, PM_VALUE_FLAGS);

      return rest[name] === undefined ? [] : [packageCall(env, rest[name]!, rest.slice(name + 1))];
    }

    // `bun test` is bun's own runner, not a script
    if (program === "bun" && sub === "test") {
      return [{ env, program: "bun test", args: rest.slice(at + 1), script: false }];
    }

    return [packageCall(env, sub, rest.slice(at + 1))];
  }

  return [{ env, program, args: rest.slice(1), script: false }];
}

/** `pnpm nx …` runs the nx binary and `pnpm vitest …` the runner; any other name is a package script. */
function packageCall(env: string[], name: string, args: string[]): Invocation {
  const binary = name === "nx" || TEST_RUNNERS.has(name);

  return { env, program: name, args, script: !binary };
}

/** The values of `-p`/`--projects` (and `=` forms), split on commas; undefined when neither appears. */
function projectsOf(args: readonly string[]): string[] | undefined {
  const flag = /^(?:-p|--projects?)(?:=(.*))?$/;

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

/** The values of `-t`/`--target`/`--targets`, split on commas. */
function targetsOf(args: readonly string[]): string[] {
  const flag = /^(?:-t|--targets?)(?:=(.*))?$/;

  return args
    .flatMap((w, i) => {
      const m = flag.exec(w);

      if (!m) {
        return [];
      }

      return m[1] !== undefined ? [m[1]] : args[i + 1] !== undefined && !args[i + 1]!.startsWith("-") ? [args[i + 1]!] : [];
    })
    .flatMap((v) => v.split(","))
    .filter(Boolean);
}

/** A test run narrowed to changed files, related files, or named spec files or folders. */
function testScoped(args: readonly string[]): boolean {
  return args.some(
    (w, i) =>
      SCOPED_TEST_FLAG.test(w) ||
      w === "related" ||
      SPEC_FILE.test(w) ||
      (!w.startsWith("-") && w.includes("/") && !(i > 0 && /^-[^=]*$/.test(args[i - 1]!))),
  );
}

function unscopedTest(what: string, target?: string): ScopeRefusal {
  const refusal: ScopeRefusal = { rule: ScopeRule.UnscopedTest, reason: `${what} runs every test: pass --changed origin/<base>, --related <file> or a spec file path` };

  if (target) {
    refusal.target = target;
  }

  return refusal;
}

function nxRefusal(args: readonly string[], maxProjects: number): ScopeRefusal | undefined {
  const sub = args[firstPositional(args, 0, new Set())];
  const targets = targetsOf(args);
  const target = targets[0];
  const withTarget = target ? { target } : {};

  if (sub === "run-many") {
    const projects = projectsOf(args);

    if (!projects?.length || args.includes("--all")) {
      return { rule: ScopeRule.RunManyAll, reason: "nx run-many with no -p/--projects runs every project", ...withTarget };
    }

    if (projects.some((p) => p === "*" || p === "**") || projects.length > maxProjects) {
      const count = projects.some((p) => p.includes("*")) ? "a * pattern" : `${projects.length} projects`;

      return { rule: ScopeRule.RunManyTooMany, reason: `nx run-many -p lists ${count}, over the cap of ${maxProjects} (check-queue.max-projects)`, ...withTarget };
    }

    const test = targets.find((t) => TEST_TARGETS.has(t));

    return test && !testScoped(args) ? unscopedTest(`nx run-many -t ${test}`, test) : undefined;
  }

  if (sub === "affected") {
    return args.includes("--all") ? { rule: ScopeRule.AffectedAll, reason: "nx affected --all runs every project", ...withTarget } : undefined;
  }

  // `nx run app:test` and `nx test app`
  const named = sub === "run" ? args[firstPositional(args, args.indexOf("run") + 1, new Set())]?.split(":").slice(1).join(":") : sub;

  return named && TEST_TARGETS.has(named) && !testScoped(args) ? unscopedTest(`nx ${named}`, named) : undefined;
}

function refusalOf(call: Invocation, maxProjects: number): ScopeRefusal | undefined {
  const skip = [...call.env, ...call.args].find((w) => SKIP_CACHE.test(w) || /^NX_SKIP_NX_CACHE=(?!false$|0$)/i.test(w));

  if (skip) {
    return { rule: ScopeRule.SkipCache, reason: `${skip} turns off the nx cache, so every project runs again` };
  }

  if (call.program === "nx") {
    return nxRefusal(call.args, maxProjects);
  }

  if (call.script) {
    return TEST_TARGETS.has(call.program) && !testScoped(call.args) ? unscopedTest(`the ${call.program} script`, call.program) : undefined;
  }

  if (TEST_RUNNERS.has(call.program)) {
    return testScoped(call.args) ? undefined : unscopedTest(call.program);
  }

  return undefined;
}

/** Why `argv` is not scoped to the branch's changes, or undefined when it is. */
export function scopeRefusal(argv: readonly string[], maxProjects: number): ScopeRefusal | undefined {
  return invocations(argv)
    .map((call) => refusalOf(call, maxProjects))
    .find((r) => r !== undefined);
}

/** The message `overbridge check` prints when it refuses `command`. */
export function refusalMessage(command: string, refusal: ScopeRefusal): string {
  const target = refusal.target ?? "<target>";

  return [
    `overbridge check refused: ${command}`,
    `  ${refusal.reason}.`,
    "CI runs the full suite. Scope the check to what the branch changed, such as:",
    `  nx affected -t ${target} --base=origin/<base>`,
    "  vitest run --changed origin/<base>",
    "where <base> is the PR's base branch (the stack base on a stacked layer, else the default branch).",
  ].join("\n");
}
