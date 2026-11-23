import { existsSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

/**
 * What `overbridge check` accepts as its command. One check is one command: a shell script that chains several is
 * refused, so each queues, runs and is timed on its own. A bare program installed in `node_modules/.bin` (`nx`,
 * `vitest`, `eslint`, `tsc`) runs from there, as `npx` would, so no `sh -c` wrapper is needed to reach it.
 */

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

/** The script a `sh -c '<script>'` argv runs; undefined for any other argv. */
export function shellScript(argv: readonly string[]): string | undefined {
  const [program, ...rest] = argv;

  if (!program || !SHELLS.has(basename(program))) {
    return undefined;
  }

  const at = rest.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));

  return at < 0 ? undefined : rest[at + 1];
}

const Quote = { None: "", Single: "'", Double: '"' } as const;

type Quote = (typeof Quote)[keyof typeof Quote];

interface Scan {
  parts: readonly string[];
  current: string;
  quote: Quote;
  escaped: boolean;
  /** The second character of `&&` or `||`, already split on. */
  skip: boolean;
}

const split = (s: Scan, more: Partial<Scan> = {}): Scan => ({ ...s, parts: [...s.parts, s.current], current: "", ...more });

function step(s: Scan, ch: string, prev: string, next: string): Scan {
  const add = (more: Partial<Scan> = {}): Scan => ({ ...s, current: s.current + ch, escaped: false, ...more });

  if (s.skip) {
    return { ...s, skip: false };
  }

  if (s.escaped) {
    return add();
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

  if (ch === "'" || ch === '"') {
    return add({ quote: ch });
  }

  if (ch === ";" || ch === "\n") {
    return split(s);
  }

  if ((ch === "&" || ch === "|") && next === ch) {
    return split(s, { skip: true });
  }

  // `&` alone runs the command before it in the background; `2>&1` and `&>` are redirects
  if (ch === "&" && prev !== ">" && next !== ">") {
    return split(s);
  }

  return add();
}

/** Lines that only set shell options, such as `set -o pipefail`, run nothing a check measures. */
const isSetOnly = (part: string) => /^set(\s|$)/.test(part);

/**
 * The commands a script chains at its top level (`;`, `&&`, `||`, `&`, newline), quotes respected. A pipeline is
 * one command; a subshell or brace group splits like the rest, since it chains as much as the top level does.
 */
export function chainedCommands(script: string): string[] {
  const chars = [...script];
  const start: Scan = { parts: [], current: "", quote: Quote.None, escaped: false, skip: false };
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
    "check's output rather than its command. Run a package bin such as nx, vitest, eslint or tsc by name; no sh -c or npx needed:",
    `  cd <dir> && overbridge check ${repo} -- vitest run <file> 2>&1 | tail -20`,
    `  overbridge check ${repo} -- nx affected -t lint --base=origin/main`,
  ].join("\n");
}

/** The `node_modules/.bin` copy of `program` nearest `cwd`, looking no higher than `rootDir`. */
export function localBin(program: string, cwd: string, rootDir: string, exists: (path: string) => boolean = existsSync): string | undefined {
  const inside = (dir: string) => !relative(rootDir, dir).startsWith("..");
  const dirs = (dir: string): string[] => (inside(dir) && dirname(dir) !== dir ? [dir, ...(dir === rootDir ? [] : dirs(dirname(dir)))] : []);

  return dirs(cwd).values().map((dir) => join(dir, "node_modules", ".bin", program)).find(exists);
}

/** `argv` with a bare program swapped for its `node_modules/.bin` copy when the repo has one, as `npx` picks it. */
export function withLocalBin(argv: readonly string[], cwd: string, rootDir: string, exists: (path: string) => boolean = existsSync): string[] {
  const [program, ...rest] = argv;

  if (!program || program.includes("/")) {
    return [...argv];
  }

  const bin = localBin(program, cwd, rootDir, exists);

  return bin ? [bin, ...rest] : [...argv];
}
