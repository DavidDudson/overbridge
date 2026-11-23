import { existsSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

/**
 * What `overbridge check` accepts as its command. One check is one command: a shell script that chains several is
 * refused, so each queues, runs and is timed on its own. A bare program installed in one of the repo's
 * `check-queue.bin-dirs` (`node_modules/.bin` by default: `nx`, `vitest`, `eslint`, `tsc`) runs from there, as `npx`
 * would, so no `sh -c` wrapper is needed to reach it.
 */

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

/** Shell options that take the next word as their value: `bash -o pipefail -c ...`. */
const VALUE_OPTIONS = new Set(["-o", "+o", "-O", "+O"]);

/** The script after a `-c` among a shell's leading options; undefined once the options end (`--` or a script file). */
function scriptAfterOptions(args: readonly string[]): string | undefined {
  const [arg, ...rest] = args;

  if (arg === undefined || arg === "--" || !/^[-+]/.test(arg)) {
    return undefined;
  }

  if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) {
    return rest[0];
  }

  return scriptAfterOptions(VALUE_OPTIONS.has(arg) ? rest.slice(1) : rest);
}

/** The script a `sh -c '<script>'` argv runs; undefined for any other argv. */
export function shellScript(argv: readonly string[]): string | undefined {
  const [program, ...rest] = argv;

  return program && SHELLS.has(basename(program)) ? scriptAfterOptions(rest) : undefined;
}

const Quote = { None: "", Single: "'", Double: '"' } as const;

type Quote = (typeof Quote)[keyof typeof Quote];

interface Scan {
  parts: readonly string[];
  current: string;
  quote: Quote;
  escaped: boolean;
  /** The second character of `&&` or `||`, already split on. */
  skipNext: boolean;
  /** Open parentheses inside a `$(`, its own included: a command substitution is part of the command around it. */
  substitution: number;
  inBackticks: boolean;
  /** Inside `[[ ... ]]`, where `&&` and `||` join conditions, not commands. */
  inTest: boolean;
  /** After an unquoted `#` that starts a word, up to the end of the line. */
  inComment: boolean;
}

const split = (s: Scan, more: Partial<Scan> = {}): Scan => ({ ...s, parts: [...s.parts, s.current], current: "", ...more });

const startsWord = (prev: string) => prev === "" || /\s|[;&|(]/.test(prev);

/** Characters that never split: inside quotes, a substitution, `[[ ]]` or a comment. Undefined when `ch` is not one of them. */
function nested(s: Scan, ch: string, prev: string, next: string, add: (more?: Partial<Scan>) => Scan): Scan | undefined {
  if (s.inComment) {
    return ch === "\n" ? split(s, { inComment: false }) : s;
  }

  if (s.quote === Quote.Single) {
    return ch === "'" ? add({ quote: Quote.None }) : add();
  }

  if (ch === "\\") {
    return add({ escaped: true });
  }

  if (s.quote === Quote.Double) {
    return ch === '"' ? add({ quote: Quote.None }) : add();
  }

  if (ch === "`") {
    return add({ inBackticks: !s.inBackticks });
  }

  if (ch === "(" && prev === "$") {
    return add({ substitution: s.substitution + 1 });
  }

  if (s.substitution > 0) {
    return ch === "(" || ch === ")" ? add({ substitution: s.substitution + (ch === "(" ? 1 : -1) }) : add();
  }

  if (s.inBackticks) {
    return add();
  }

  if (ch === "[" && next === "[" && startsWord(prev)) {
    return add({ inTest: true });
  }

  if (s.inTest) {
    return ch === "]" && prev === "]" ? add({ inTest: false }) : add();
  }

  return undefined;
}

function step(s: Scan, ch: string, prev: string, next: string): Scan {
  const add = (more: Partial<Scan> = {}): Scan => ({ ...s, current: s.current + ch, escaped: false, ...more });

  if (s.skipNext) {
    return { ...s, skipNext: false };
  }

  if (s.escaped) {
    return add();
  }

  const inside = nested(s, ch, prev, next, add);

  if (inside) {
    return inside;
  }

  if (ch === "'" || ch === '"') {
    return add({ quote: ch });
  }

  if (ch === "#" && startsWord(prev)) {
    return { ...s, inComment: true };
  }

  if (ch === ";" || ch === "\n") {
    return split(s);
  }

  if ((ch === "&" || ch === "|") && next === ch) {
    return split(s, { skipNext: true });
  }

  // `&` alone runs the command before it in the background; `2>&1`, `&>` and `|&` are redirects
  if (ch === "&" && prev !== ">" && prev !== "|" && next !== ">") {
    return split(s);
  }

  return add();
}

/** Lines that only set shell options, such as `set -o pipefail`, run nothing a check measures. */
const isSetOnly = (part: string) => /^set(\s|$)/.test(part);

/**
 * The commands a script chains at its top level (`;`, `&&`, `||`, `&`, newline). Quotes, `$(...)`, backticks, `[[ ]]`
 * and comments never split, and a pipeline is one command. A subshell or brace group splits like the rest, since it
 * chains as much as the top level does.
 */
export function chainedCommands(script: string): string[] {
  const chars = [...script];
  const start: Scan = { parts: [], current: "", quote: Quote.None, escaped: false, skipNext: false, substitution: 0, inBackticks: false, inTest: false, inComment: false };
  const end = chars.reduce((s, ch, i) => step(s, ch, chars[i - 1] ?? "", chars[i + 1] ?? ""), start);

  return [...end.parts, end.current].flatMap((p) => {
    const part = p.trim();

    return part === "" || isSetOnly(part) ? [] : [part];
  });
}

/** Why `argv` is not one check, with how to queue it instead; undefined when it is one command. */
export function chainRefusal(argv: readonly string[], repo: string): string | undefined {
  const script = shellScript(argv);
  const parts = script === undefined ? [] : chainedCommands(script);

  if (parts.length < 2) {
    return undefined;
  }

  return [
    `overbridge check runs one command, but this script chains ${parts.length}: ${parts.map((p) => `\`${p}\``).join(", ")}.`,
    "Queue each command as its own check, run `cd <dir>` before overbridge check rather than inside it, and pipe the",
    "check's output rather than its command (with set -o pipefail, so the check's exit code survives the pipe). Run a package",
    "bin such as nx, vitest, eslint or tsc by name; no sh -c or npx needed:",
    `  set -o pipefail; cd <dir> && overbridge check ${repo} -- vitest run <file> 2>&1 | tail -20`,
    `  overbridge check ${repo} -- nx affected -t lint --base=origin/<base>`,
  ].join("\n");
}

/** The copy of `program` in a `binDirs` folder nearest `cwd`, looking no higher than `rootDir`. */
export function localBin(program: string, cwd: string, rootDir: string, binDirs: readonly string[], exists: (path: string) => boolean = existsSync): string | undefined {
  const inside = (dir: string) => !relative(rootDir, dir).startsWith("..");
  const dirs = (dir: string): string[] => (inside(dir) && dirname(dir) !== dir ? [dir, ...(dir === rootDir ? [] : dirs(dirname(dir)))] : []);

  return dirs(cwd).values().flatMap((dir) => binDirs.map((bin) => join(dir, bin, program))).find(exists);
}

/** `argv` with a bare program swapped for its copy in `binDirs` when the repo has one, as `npx` picks it. */
export function withLocalBin(argv: readonly string[], cwd: string, rootDir: string, binDirs: readonly string[], exists: (path: string) => boolean = existsSync): string[] {
  const [program, ...rest] = argv;

  if (!program || program.includes("/")) {
    return [...argv];
  }

  const bin = localBin(program, cwd, rootDir, binDirs, exists);

  return bin ? [bin, ...rest] : [...argv];
}
