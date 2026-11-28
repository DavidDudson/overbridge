/**
 * Focused diff: unified diff text in, analysis, mini diff out. Pure and deterministic, and conservative:
 * a block it cannot prove is noise is shown. The lexer is language-agnostic, so it never fails to parse.
 */

export enum Noise {
  Format = "format",
  Imports = "imports",
  Moved = "moved",
  Comments = "comments",
  Generated = "generated",
  Renamed = "renamed",
  Mode = "mode",
  /** A new test or story file: listed with its size, its lines are not shown. */
  Tests = "tests",
  /** The same edit, line for line, as a file shown above: listed, not repeated. */
  Repeated = "repeated",
}

export const NOISE_KINDS: readonly string[] = Object.values(Noise);

export const isNoise = (s: string): s is Noise => NOISE_KINDS.includes(s);

export interface DiffLine {
  kind: " " | "+" | "-";
  text: string;
  /** 1-based line number: in the old file for `-`, in the new file for `+` and context. */
  no: number;
}

export interface Hunk {
  header: string;
  lines: DiffLine[];
}

export type FileStatus = "modified" | "added" | "deleted" | "renamed";

export interface FileDiff {
  path: string;
  oldPath: string;
  status: FileStatus;
  similarity?: number;
  modeChange: boolean;
  binary: boolean;
  hunks: Hunk[];
}

/** Unchanged lines between change blocks. */
export interface Context {
  context: true;
  lines: string[];
}

/** A run of removed and added lines; `noise` is set when it is not worth reading. */
export interface Change {
  context?: false;
  removed: string[];
  added: string[];
  noise?: Noise;
  /** Lines the syntax-aware differ says only changed in layout, left out of `removed` and `added`. */
  layout?: number;
}

export type Part = Context | Change;

export interface AnalyzedHunk {
  header: string;
  parts: Part[];
}

export interface AnalyzedFile extends Omit<FileDiff, "hunks"> {
  /** Set when the whole file is noise. */
  noise?: Noise;
  /** On a file hidden as repeated: the file whose identical change is shown. */
  sameAs?: string;
  /** On the file that shows a change: the other files that carry the same one. */
  repeats?: string[];
  hunks: AnalyzedHunk[];
}

/**
 * What a syntax-aware differ (difftastic) says about one file: the 1-based lines it reports as changed on each side,
 * and, of those, the lines where every changed token is a comment. A line it does not report only changed in layout.
 */
export interface FileFacts {
  oldChanged: ReadonlySet<number>;
  newChanged: ReadonlySet<number>;
  oldComment: ReadonlySet<number>;
  newComment: ReadonlySet<number>;
}

export interface FocusOptions {
  /** Noise kinds to show anyway. */
  keep?: ReadonlySet<Noise>;
  /** Per new path, what the syntax-aware differ found; a file with no entry is judged by the lexer alone. */
  facts?: ReadonlyMap<string, FileFacts>;
  /** Globs of generated files (repo config): their changes collapse to one line. */
  generated?: readonly string[];
  /** Added or deleted files print this many lines, then a count. */
  maxWholeFileLines?: number;
}

/** A line from a file, safe to print: control characters (ESC could recolour or hide output) and bidi or zero-width characters replaced. A trailing CR stays until render. */
const clean = (line: string) => line.replace(/(?![\t\r])[\p{Cc}\p{Cf}]/gu, "\uFFFD");

const noCr = (line: string) => line.replace(/\r$/, "");

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Reads unified diff text (`git diff`, with or without `-M`) into files. Unknown lines are skipped. */
export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = text.split("\n");
  let file: FileDiff | undefined;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;

    if (l.startsWith("diff --git ")) {
      const rest = l.slice("diff --git ".length);
      const at = rest.indexOf(" b/");
      const oldPath = at < 0 ? rest : rest.slice(2, at);
      const path = at < 0 ? rest : rest.slice(at + 3);
      file = { path, oldPath, status: "modified", modeChange: false, binary: false, hunks: [] };
      files.push(file);
      continue;
    }

    if (!file) continue;

    if (l.startsWith("new file mode")) file.status = "added";
    else if (l.startsWith("deleted file mode")) file.status = "deleted";
    else if (l.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = l.slice("rename from ".length);
    } else if (l.startsWith("rename to ")) file.path = l.slice("rename to ".length);
    else if (l.startsWith("similarity index ")) file.similarity = Number.parseInt(l.slice("similarity index ".length), 10);
    else if (l.startsWith("old mode ") || l.startsWith("new mode ")) file.modeChange = true;
    else if (l.startsWith("Binary files ") || l.startsWith("GIT binary patch")) file.binary = true;
    else if (l.startsWith("--- ") && file.hunks.length === 0) {
      if (l !== "--- /dev/null") file.oldPath = l.slice(l.startsWith("--- a/") ? 6 : 4);
    } else if (l.startsWith("+++ ") && file.hunks.length === 0) {
      if (l !== "+++ /dev/null") file.path = l.slice(l.startsWith("+++ b/") ? 6 : 4);
      else file.path = file.oldPath;
    } else {
      const m = HUNK_HEADER.exec(l);

      if (!m) continue;

      let oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      let newLeft = m[4] === undefined ? 1 : Number(m[4]);
      let oldNo = Number(m[1]);
      let newNo = Number(m[3]);
      const hunk: Hunk = { header: l, lines: [] };

      while ((oldLeft > 0 || newLeft > 0) && i + 1 < lines.length) {
        const b = lines[i + 1]!;
        const k = b === "" ? " " : b[0];

        if (k === " ") {
          oldLeft--;
          newLeft--;
          hunk.lines.push({ kind: " ", text: clean(b.slice(1)), no: newNo });
          oldNo++;
          newNo++;
        } else if (k === "-") {
          oldLeft--;
          hunk.lines.push({ kind: "-", text: clean(b.slice(1)), no: oldNo++ });
        } else if (k === "+") {
          newLeft--;
          hunk.lines.push({ kind: "+", text: clean(b.slice(1)), no: newNo++ });
        } else if (k !== "\\") break;

        i++;
      }

      if (lines[i + 1]?.startsWith("\\")) i++;
      file.hunks.push(hunk);
    }
  }

  return files;
}

interface Lang {
  /** A trimmed line that is only a comment. */
  comment: RegExp;
  /** Import statements; the lines of a change that match nothing else are not imports. */
  imports?: RegExp;
  /** The line before a member list inside a multi-line import. */
  opener?: RegExp;
  /** Leading indentation is meaning here, so it stays in the comparison. */
  indent?: boolean;
  /** 'x' and "x" are the same string. */
  quotes?: boolean;
  /** A trailing `;` is optional. */
  semicolons?: boolean;
  /** C-style block comments, whose continuation lines start with `*`. */
  block?: boolean;
}

const NEVER = /(?!)/;
const SLASH_COMMENT = /^(\/\/|\/\*|\*\/)/;

const JS: Lang = {
  comment: SLASH_COMMENT,
  block: true,
  quotes: true,
  semicolons: true,
  imports:
    /^\s*(?:import\s+(?:type\s+)?(?:[^;'"]*?\sfrom\s*)?['"][^'"]+['"]|export\s+(?:type\s+)?(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s+from\s*['"][^'"]+['"]|(?:const|let|var)\s+[^=;]+=\s*require\(\s*['"][^'"]+['"]\s*\))\s*;?\s*$/gm,
  opener: /^(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{$/,
};

const PY: Lang = {
  comment: /^#/,
  imports: /^\s*(?:from\s+[\w.]+\s+import\s+(?:\([^)]*\)|[^\n(]+)|import\s+[^\n]+)\s*$/gm,
  opener: /^from\s+\S+\s+import\s*\($/,
  indent: true,
  quotes: true,
};

const RUST: Lang = {
  comment: /^\/\//,
  imports: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:use\s+[^;]+;|extern\s+crate\s+[^;]+;)\s*$/gm,
  opener: /^(?:pub(?:\([^)]*\))?\s+)?use\s+[\w:]*\{$/,
};

const GO: Lang = {
  comment: /^\/\//,
  imports: /^\s*import\s*(?:\([^)]*\)|(?:[\w.]+\s+)?"[^"]+")\s*$/gm,
  opener: /^import\s*\($/,
};

const JVM: Lang = { comment: SLASH_COMMENT, block: true, imports: /^\s*(?:import|using|package)\s+[^\n;]+;?\s*$/gm };
const C: Lang = { comment: SLASH_COMMENT, block: true, imports: /^\s*#\s*(?:include|import)\s+[<"][^>"]+[>"]\s*$/gm };
const HASH: Lang = { comment: /^#/ };
const HASH_INDENT: Lang = { comment: /^#/, indent: true };
const PLAIN: Lang = { comment: NEVER };

/** Unknown files: whitespace at the start of a line may matter, nothing is a comment. */
const UNKNOWN: Lang = { comment: NEVER, indent: true };

const LANGS = new Map<string, Lang>(Object.entries({
  ts: JS, tsx: JS, js: JS, jsx: JS, mjs: JS, cjs: JS, mts: JS, cts: JS,
  py: PY, rs: RUST, go: GO,
  java: JVM, kt: JVM, kts: JVM, scala: JVM, swift: JVM, dart: JVM, cs: JVM,
  c: C, h: C, cc: C, cpp: C, hpp: C,
  sh: HASH, bash: HASH, rb: HASH, nix: HASH, toml: HASH,
  yml: HASH_INDENT, yaml: HASH_INDENT,
  json: PLAIN, css: PLAIN, scss: PLAIN,
} satisfies Record<string, Lang>));

const langOf = (path: string): Lang => LANGS.get(path.slice(path.lastIndexOf(".") + 1).toLowerCase()) ?? UNKNOWN;

const GENERATED = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|flake\.lock|go\.sum|poetry\.lock|Gemfile\.lock|composer\.lock|Pipfile\.lock|uv\.lock)$/,
  /\.min\.(js|css)$/,
  /\.(pb\.go|generated\.\w+)$/,
  /(^|\/)(dist|__generated__)\//,
];

/** An unchanged line in the first lines of a file that says so. A line the diff adds proves nothing: its author could write it. */
const GENERATED_HEADER = /@generated|\bDO NOT EDIT\b|\bauto-?generated\b|\bgenerated (?:by|file|code)\b/i;
const HEADER_LINES = 10;

const hasGeneratedHeader = (file: FileDiff) => file.hunks.some((h) => h.lines.some((l) => l.kind === " " && l.no <= HEADER_LINES && GENERATED_HEADER.test(l.text)));

const isGenerated = (file: FileDiff, globs: readonly Bun.Glob[]) =>
  GENERATED.some((re) => re.test(file.path)) || globs.some((g) => g.match(file.path)) || hasGeneratedHeader(file);

const TESTS = [
  /(^|\/)(__tests__|tests?|specs?|e2e)\//,
  /\.(test|spec|stories)\.[\w]+$/,
  /[_-]tests?\.[\w]+$/,
  /(^|\/)test_[^/]+\.py$/,
  /Tests?\.(kt|java|cs|swift)$/,
];

const isTestFile = (path: string) => TESTS.some((re) => re.test(path));

const TOKEN = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[A-Za-z_$][\w$]*|\d[\w.]*|[-+*/%=!<>&|^~?.:]{2,3}|\S/g;
const CLOSERS = new Set([")", "]", "}"]);

/** 'x' and "x" are the same token when neither needs an escape. */
const unquote = (t: string, on: boolean) => (on && t[0] === "'" && !t.includes('"') && !t.includes("\\") ? `"${t.slice(1, -1)}"` : t);

interface Style {
  indent: boolean;
  quotes: boolean;
  semicolons: boolean;
}

const styleOf = (lang: Lang, semicolons = true): Style => ({ indent: !!lang.indent, quotes: !!lang.quotes, semicolons: semicolons && !!lang.semicolons });

/** What a formatter cannot change: tokens without `;`, trailing commas, whitespace and quote style. */
function tokens(lines: readonly string[], style: Style): string[] {
  const all: string[] = [];

  for (const line of lines) {
    if (style.indent && line.trim()) all.push(`⇥${line.length - line.trimStart().length}`);

    for (const m of line.matchAll(TOKEN)) all.push(unquote(m[0], style.quotes));
  }

  const nextReal = (from: number) => {
    let j = from;

    while (j < all.length && all[j]!.startsWith("⇥")) j++;

    return all[j];
  };

  return all.filter((t, i) => {
    if (t === ";" && style.semicolons) return false;

    if (t !== ",") return true;

    const next = nextReal(i + 1);

    return !(next === undefined || CLOSERS.has(next));
  });
}

const COMMENT_OPENER = /\/\/|\/\*|#|--/;
const JUMP = /\b(?:return|throw|break|continue|yield)\s*$/;

/**
 * True when only layout changed. Joining lines can change meaning (onto a line comment, after `return`) and
 * `;` is optional only line for line, so a block whose line count changed with either at stake is signal.
 */
/** A line starting like this continues the line before it unless that line ends in `;`. */
const CONTINUES = /^\s*(?:[([`+\-/*.]|(?:if|while|for|else|do)\b)/;

function formatOnly(removed: readonly string[], added: readonly string[], next: string, lang: Lang): boolean {
  const sameLines = removed.length === added.length;
  const crlf = (ls: readonly string[]) => ls.some((l) => l.endsWith("\r"));

  if (crlf(removed) !== crlf(added)) return false;

  if (!sameLines && [...removed, ...added].some((l) => COMMENT_OPENER.test(l) || JUMP.test(l))) return false;

  const style = styleOf(lang, sameLines && ![...removed, ...added, next].some((l) => CONTINUES.test(l)));
  const x = tokens(removed, style);
  const y = tokens(added, style);

  return x.length === y.length && x.every((t, i) => t === y[i]);
}

const nonBlank = (lines: readonly string[]) => lines.filter((l) => l.trim());

const MEMBER = /^(?:[\w$]+(?:\s+as\s+[\w$]+)?|type\s+[\w$]+|"[^"]+"|[\w.]+\s+"[^"]+"),?$/;

/** True when every line of a change is an import statement, or a member inside an import's braces. */
function onlyImports(lines: readonly string[], before: readonly string[], lang: Lang): boolean {
  const real = nonBlank(lines);

  if (!real.length || !lang.imports) return false;

  if (real.join("\n").replace(lang.imports, "").trim() === "") return true;

  if (!lang.opener || !real.every((l) => MEMBER.test(l.trim()))) return false;

  for (let i = before.length - 1; i >= 0; i--) {
    const t = before[i]!.trim();

    if (lang.opener.test(t)) return true;

    if (!MEMBER.test(t)) return false;
  }

  return false;
}

/** The module an import line names, else the line itself; used to say what an imports change added. */
export function importTarget(line: string): string {
  const quoted = /['"<]([^'">]+)['">]/.exec(line);

  if (quoted) return quoted[1]!;

  const word = /\b(?:from|import|use|using|include)\s+([\w.:]+)/.exec(line);

  return word ? word[1]! : line.trim().replace(/,$/, "");
}

const lineKey = (line: string, lang: Lang) => tokens([line], styleOf(lang)).join(" ");

/** A line must be at least this long, normalised, to count as moved: `}` and `return;` appear everywhere. */
const MOVED_MIN_KEY = 16;

/** A move hides only a run of this many such lines: one relocated guard clause must stay visible. */
const MOVED_MIN_LINES = 3;

type Pool = Map<string, number>;

function bump<K>(m: Map<K, number>, k: K) {
  m.set(k, (m.get(k) ?? 0) + 1);
}

function analyzeHunk(file: FileDiff, hunk: Hunk, lang: Lang, removedPool: Pool, addedPool: Pool, keep: ReadonlySet<Noise>, facts: FileFacts | undefined): AnalyzedHunk {
  const parts: Part[] = [];
  const seen: string[] = []; // the new-side lines before the current part, for imports inside braces
  const lines = hunk.lines;

  for (let i = 0; i < lines.length; ) {
    if (lines[i]!.kind === " ") {
      const ctx: string[] = [];

      for (; i < lines.length && lines[i]!.kind === " "; i++) ctx.push(lines[i]!.text);
      parts.push({ context: true, lines: ctx });
      seen.push(...ctx);
      continue;
    }

    const removedLines: DiffLine[] = [];
    const addedLines: DiffLine[] = [];

    for (; i < lines.length && lines[i]!.kind !== " "; i++) (lines[i]!.kind === "-" ? removedLines : addedLines).push(lines[i]!);

    const removed = removedLines.map((l) => l.text);
    const added = addedLines.map((l) => l.text);
    const change: Change = { removed, added };
    const wholeFile = file.status === "added" || file.status === "deleted";
    const noise = wholeFile ? undefined : (facts && factsVerdict(facts, removedLines, addedLines)) ?? classify(removed, added, lines[i]?.text ?? "", seen, lang, removedPool, addedPool, !facts);

    if (noise && !keep.has(noise)) change.noise = noise;
    else if (!noise && facts && !wholeFile) trimLayout(change, removedLines, addedLines, facts);

    parts.push(change);
    seen.push(...added);
  }

  return { header: hunk.header, parts };
}

const STAR_LINE = /^\*(\s|$)/;

/** Comments that act on tools or the runtime: not prose. */
const DIRECTIVE = /^(?:#!|\/\/\s*(?:go:|#|@ts-|eslint|prettier|nolint|nosec|biome|istanbul)|\/\*\s*(?:eslint|prettier|istanbul|webpack)|#\s*(?:type:|noqa|pragma|nosec|shellcheck|pylint|pyright|mypy|fmt:|isort:))/;

/** True when the line is nothing but comment: no code after a closing star-slash or before an opener. */
function commentOnly(line: string, lang: Lang): boolean {
  let t = line.trim();

  if (DIRECTIVE.test(t)) return false;

  if (lang.block) {
    if (t.startsWith("*/")) t = t.slice(2).trim();

    t = t.replace(/\/\*.*?\*\//g, " ").trim();

    const open = t.indexOf("/*");

    if (open >= 0) t = t.slice(0, open).trim();
  }

  return t === "" || (lang.comment.test(t) && !t.startsWith("/*") && !t.startsWith("*/"));
}

/** True when `before` leaves a block comment open. */
function inBlockComment(before: readonly string[]): boolean {
  let open = false;

  for (const l of before) {
    const a = l.lastIndexOf("/*");
    const b = l.lastIndexOf("*/");

    if (a > b) open = true;
    else if (b > a) open = false;
  }

  return open;
}

/** True when every line is a comment and each `/*` closes inside the block; `*` lines count only inside a comment. */
function onlyComments(real: readonly string[], before: readonly string[], lang: Lang): boolean {
  if (!real.length) return false;

  const opens = real.filter((l) => l.includes("/*")).length;
  const closes = real.filter((l) => l.includes("*/")).length;

  if (lang.block && opens !== closes) return false;

  const starOk = !!lang.block && (inBlockComment(before) || real.some((l) => l.trim().startsWith("/*")));

  return real.every((l) => (starOk && STAR_LINE.test(l.trim()) && !DIRECTIVE.test(l.trim())) || (lang.comment.test(l.trim()) && commentOnly(l, lang)));
}

/** Drops from a signal block the lines the syntax-aware differ did not report: they only changed in layout. */
function trimLayout(change: Change, removed: readonly DiffLine[], added: readonly DiffLine[], facts: FileFacts) {
  const keepRemoved = removed.filter((l) => facts.oldChanged.has(l.no));
  const keepAdded = added.filter((l) => facts.newChanged.has(l.no));
  const dropped = removed.length - keepRemoved.length + (added.length - keepAdded.length);

  if (!dropped || (!keepRemoved.length && !keepAdded.length)) return;

  change.removed = keepRemoved.map((l) => l.text);
  change.added = keepAdded.map((l) => l.text);
  change.layout = dropped;
}

/**
 * The syntax-aware differ's verdict on a block: no line of it reported as changed means only layout moved,
 * and changed lines that are all comments (and not tool directives) are a comment edit. Else undefined.
 */
function factsVerdict(facts: FileFacts, removed: readonly DiffLine[], added: readonly DiffLine[]): Noise | undefined {
  const changedRemoved = removed.filter((l) => facts.oldChanged.has(l.no));
  const changedAdded = added.filter((l) => facts.newChanged.has(l.no));

  if (!changedRemoved.length && !changedAdded.length) return Noise.Format;

  const comments = changedRemoved.every((l) => facts.oldComment.has(l.no)) && changedAdded.every((l) => facts.newComment.has(l.no));

  if (comments && ![...changedRemoved, ...changedAdded].some((l) => DIRECTIVE.test(l.text.trim()))) return Noise.Comments;
}

/** With `lexComments` off the syntax-aware differ owns the comment call, so the lexer's guess at it is skipped. */
function classify(removed: string[], added: string[], next: string, before: readonly string[], lang: Lang, removedPool: Pool, addedPool: Pool, lexComments: boolean): Noise | undefined {
  if (formatOnly(removed, added, next, lang)) return Noise.Format;

  if (onlyImports([...removed, ...added], before, lang)) return Noise.Imports;

  // every non-blank line must keep its count across the file, so a short changed line is never hidden with a moved one
  const keys = nonBlank([...removed, ...added]).map((l) => lineKey(l, lang));
  const moved = keys.length > 0 && keys.every((k) => (removedPool.get(k) ?? 0) === (addedPool.get(k) ?? 0));

  if (moved && keys.filter((k) => k.length >= MOVED_MIN_KEY).length >= MOVED_MIN_LINES) return Noise.Moved;

  if (lexComments && onlyComments(nonBlank([...removed, ...added]), before, lang)) return Noise.Comments;
}

/** Tags the noise in each file. Whole-file noise first (generated, rename, mode), then block by block. */
export function analyze(files: FileDiff[], options: FocusOptions = {}): AnalyzedFile[] {
  const keep = options.keep ?? new Set<Noise>();
  const globs = (options.generated ?? []).map((g) => new Bun.Glob(g));

  return groupRepeats(analyzeFiles(files, options, keep, globs), keep);
}

/** Files that carry the same edit, line for line, as a file above show it once; this many make a group. */
const MIN_REPEATS = 3;

/** The edit a modified file carries, as text; undefined when it has none worth comparing. */
function signature(f: AnalyzedFile): string | undefined {
  if (f.noise || f.status !== "modified" || f.binary || f.modeChange) return undefined;

  const sig = changes(f)
    .flatMap((c) => (isSignal(c) ? [JSON.stringify([c.removed.map((l) => l.trim()), c.added.map((l) => l.trim())])] : []))
    .join("|");

  return sig || undefined;
}

function groupRepeats(files: AnalyzedFile[], keep: ReadonlySet<Noise>): AnalyzedFile[] {
  if (keep.has(Noise.Repeated)) return files;

  const groups = new Map<string, AnalyzedFile[]>();

  for (const f of files) {
    const sig = signature(f);

    if (sig !== undefined) groups.set(sig, [...(groups.get(sig) ?? []), f]);
  }

  const first = new Map<AnalyzedFile, AnalyzedFile[]>();
  const rest = new Map<AnalyzedFile, AnalyzedFile>();

  for (const g of groups.values()) {
    if (g.length < MIN_REPEATS) continue;

    first.set(g[0]!, g.slice(1));

    for (const f of g.slice(1)) rest.set(f, g[0]!);
  }

  return files.map((f) => {
    const head = rest.get(f);

    if (head) return { ...f, noise: Noise.Repeated, sameAs: head.path };

    const others = first.get(f);

    return others ? { ...f, repeats: others.map((o) => o.path) } : f;
  });
}

function analyzeFiles(files: FileDiff[], options: FocusOptions, keep: ReadonlySet<Noise>, globs: readonly Bun.Glob[]): AnalyzedFile[] {
  return files.map((file): AnalyzedFile => {
    const lang = langOf(file.path);
    const unlessKept = (kind: Noise) => (keep.has(kind) ? undefined : kind);
    const noHunks: AnalyzedHunk[] = [];
    const base = { ...file, hunks: noHunks };

    if (!file.binary && isGenerated(file, globs)) return { ...base, noise: unlessKept(Noise.Generated), hunks: analyzeAll(file, lang, new Map(), new Map(), keep, undefined) };

    if (file.status === "added" && !file.binary && isTestFile(file.path)) return { ...base, noise: unlessKept(Noise.Tests), hunks: analyzeAll(file, lang, new Map(), new Map(), keep, undefined) };

    if (!file.hunks.length && !file.binary) {
      if (file.status === "renamed" && !file.modeChange) return { ...base, noise: unlessKept(Noise.Renamed) };

      if (file.modeChange) return { ...base, noise: unlessKept(Noise.Mode) };
    }

    const removedPool: Pool = new Map();
    const addedPool: Pool = new Map();

    for (const h of file.hunks) {
      for (const l of h.lines) if (l.kind !== " " && l.text.trim()) bump(l.kind === "-" ? removedPool : addedPool, lineKey(l.text, lang));
    }

    return { ...base, hunks: analyzeAll(file, lang, removedPool, addedPool, keep, options.facts?.get(file.path)) };
  });
}

const analyzeAll = (file: FileDiff, lang: Lang, removedPool: Pool, addedPool: Pool, keep: ReadonlySet<Noise>, facts: FileFacts | undefined) =>
  file.hunks.map((h) => analyzeHunk(file, h, lang, removedPool, addedPool, keep, facts));

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

const CONTEXT_LINES = 2;
const MAX_TARGETS = 4;
export const MAX_WHOLE_FILE_LINES = 20;

const changes = (file: AnalyzedFile): Change[] => file.hunks.flatMap((h) => h.parts.filter((p): p is Change => !p.context));

const isSignal = (c: Change) => !c.noise;

/** A file prints in full when it is not noise and has a signal change, or has nothing line-based to say (binary, empty add). */
const showsFile = (f: AnalyzedFile) => !f.noise && (f.binary || changes(f).some(isSignal) || !f.hunks.length);

const count = (cs: Change[]) => ({ added: cs.reduce((n, c) => n + c.added.length, 0), removed: cs.reduce((n, c) => n + c.removed.length, 0) });

/** `⋯ imports +zod −lodash`: what a hidden block was, short enough to scan. */
function marker(c: Change, kind: Noise): string {

  if (kind === Noise.Imports) {
    const gone = new Set(c.removed.filter((l) => l.trim()).map(importTarget));
    const came = new Set(c.added.filter((l) => l.trim()).map(importTarget));
    const net = [...came.difference(gone).keys().map((t) => `+${t}`), ...gone.difference(came).keys().map((t) => `−${t}`)];

    if (!net.length) return `⋯ ${kind} reordered`;

    const shown = net.slice(0, MAX_TARGETS).join(" ");

    return `⋯ ${kind} ${shown}${net.length > MAX_TARGETS ? ` +${net.length - MAX_TARGETS} more` : ""}`;
  }

  return `⋯ ${kind} +${c.added.length} −${c.removed.length}`;
}

function renderHunk(hunk: AnalyzedHunk): string[] {
  const out = [`${DIM}${hunk.header}${RESET}`];
  const { parts } = hunk;

  parts.forEach((p, i) => {
    if (p.context) {
      const head = i > 0 ? p.lines.slice(0, CONTEXT_LINES) : [];
      const tail = i < parts.length - 1 ? p.lines.slice(Math.max(head.length, p.lines.length - CONTEXT_LINES)) : [];

      for (const l of [...head, ...tail]) out.push(` ${noCr(l)}`);
    } else if (p.noise) {
      out.push(`${DIM} ${marker(p, p.noise)}${RESET}`);
    } else {
      for (const l of p.removed) out.push(`${RED}-${noCr(l)}${RESET}`);

      for (const l of p.added) out.push(`${GREEN}+${noCr(l)}${RESET}`);

      if (p.layout) out.push(`${DIM} ⋯ ${Noise.Format} ${p.layout} more line${p.layout === 1 ? "" : "s"} re-indented or reflowed${RESET}`);
    }
  });

  return out;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

const CLOSERS_ONLY = /^[)\]}>,;\s]+$/;

/**
 * A whole file in at most `max` lines: the top two nesting levels, without imports, comments, closers or blank
 * lines (declarations, class members, test titles, top keys). A file that fits is returned as is.
 */
function outline(lines: readonly string[], lang: Lang, max: number): string[] {
  if (lines.length <= max) return [...lines];

  const imported = new Set<number>();

  if (lang.imports) {
    const text = lines.join("\n");
    const starts: number[] = [];
    let at = 0;

    for (const l of lines) {
      starts.push(at);
      at += l.length + 1;
    }

    let row = 0;

    for (const m of text.matchAll(lang.imports)) {
      while (row + 1 < starts.length && starts[row + 1]! <= m.index) row++;

      for (let n = row; n < row + m[0].split("\n").length; n++) imported.add(n);
    }
  }

  const unit = Math.min(...lines.flatMap((l) => (l.trim() && indentOf(l) > 0 ? [indentOf(l)] : [])));
  const level = (l: string) => (Number.isFinite(unit) ? Math.floor(indentOf(l) / unit) : 0);

  const isComment = (t: string) => lang.comment.test(t) || (!!lang.block && STAR_LINE.test(t));

  const kept = lines.filter((l, i) => l.trim() && !imported.has(i) && level(l) <= 1 && !CLOSERS_ONLY.test(l) && !isComment(l.trim()));

  return (kept.length ? kept : lines).slice(0, max);
}

const countKinds = (cs: Iterable<Change>) => {
  const kinds = new Map<Noise, number>();

  for (const c of cs) if (c.noise) bump(kinds, c.noise);

  return kinds;
};

const fileName = (f: AnalyzedFile) => (f.status === "renamed" ? `${f.oldPath} \u2192 ${f.path}` : f.path);

const tally = (kinds: Map<Noise, number>) => [...kinds].map(([k, n]) => `${k} ${n}`).join(" · ");

/** The mini diff: files with real changes first, then one line per file that was all noise. */
export function renderFocused(files: AnalyzedFile[], options: FocusOptions = {}): string {
  if (!files.length) return "";

  const maxWhole = options.maxWholeFileLines ?? MAX_WHOLE_FILE_LINES;
  const hidden = new Map<Noise, number>();
  const hide = (k: Noise) => hidden.set(k, (hidden.get(k) ?? 0) + 1);
  const body: string[] = [];
  const collapsed: string[] = [];
  let shownFiles = 0;
  let shownChanges = 0;

  for (const f of files) {
    const cs = changes(f);

    if (f.noise) {
      hide(f.noise);
      const { added, removed } = count(cs);
      const name = fileName(f);
      collapsed.push(`  ${name}  ${f.noise}${f.sameAs ? ` of ${f.sameAs}` : ""}${added + removed ? ` +${added} −${removed}` : ""}`);
      continue;
    }

    for (const c of cs) if (c.noise) hide(c.noise);

    if (!showsFile(f)) {
      // nothing here but noise blocks; reported as one collapsed line
      collapsed.push(`  ${fileName(f)}  ${tally(countKinds(cs))}`);
      continue;
    }

    shownFiles++;
    shownChanges += cs.filter(isSignal).length;

    const shown = count(cs.filter(isSignal));
    const same = f.repeats?.length ? ` (the same change in ${f.repeats.length} more file${f.repeats.length === 1 ? "" : "s"}, listed below)` : "";
    const tag = same || (f.status === "modified" ? "" : f.status === "renamed" ? ` (renamed from ${f.oldPath}${f.similarity !== undefined ? `, ${f.similarity}%` : ""})` : ` (${f.status})`);
    body.push(`${BOLD}── ${f.path}${RESET}${DIM}${tag} ${RESET}${GREEN}+${shown.added}${RESET} ${RED}−${shown.removed}${RESET}`);

    if (f.binary) body.push(`${DIM} binary file differs${RESET}`);

    if (f.status === "added" || f.status === "deleted") {
      const sign = f.status === "added" ? "+" : "-";
      const color = f.status === "added" ? GREEN : RED;
      const lines = cs.flatMap((c) => (f.status === "added" ? c.added : c.removed));
      const outlined = outline(lines, langOf(f.path), maxWhole);

      for (const l of outlined) body.push(`${color}${sign}${noCr(l)}${RESET}`);

      if (lines.length > outlined.length) body.push(`${DIM} ⋯ ${lines.length - outlined.length} more lines${lines.length > maxWhole ? " (outline)" : ""}${RESET}`);
      body.push("");
      continue;
    }

    const quiet = new Map<Noise, number>();

    for (const h of f.hunks) {
      if (h.parts.some((p) => !p.context && isSignal(p))) body.push(...renderHunk(h));
      else for (const p of h.parts) if (!p.context && p.noise) quiet.set(p.noise, (quiet.get(p.noise) ?? 0) + 1);
    }

    if (quiet.size) body.push(`${DIM} ⋯ also hidden: ${tally(quiet)}${RESET}`);
    body.push("");
  }

  const summary = `${BOLD}focused diff${RESET} ${CYAN}${shownFiles} of ${files.length} file${files.length === 1 ? "" : "s"}, ${shownChanges} change${shownChanges === 1 ? "" : "s"}${RESET}${hidden.size ? `${DIM} · hidden: ${tally(hidden)}${RESET}` : ""}`;
  const tail = collapsed.length ? [`${DIM}collapsed${RESET}`, ...collapsed.map((l) => `${DIM}${l}${RESET}`), ""] : [];

  return [summary, "", ...body, ...tail].join("\n");
}

/** Unified diff text in, mini diff out. */
export const focusedDiff = (diffText: string, options: FocusOptions = {}): string => renderFocused(analyze(parseDiff(diffText), options), options);

export interface HiddenStats {
  /** Files hidden whole (generated, new tests, renames, mode changes). */
  files: number;
  blocks: number;
  lines: number;
}

export interface Stats {
  files: number;
  /** Files with something left to read. */
  review: number;
  lines: number;
  /** Changed lines in the files with something left to read, less the noise blocks inside them. */
  reviewLines: number;
  hidden: Map<Noise, HiddenStats>;
}

const lineCount = (cs: readonly Change[]) => cs.reduce((n, c) => n + c.added.length + c.removed.length, 0);

const layoutCount = (cs: readonly Change[]) => cs.reduce((n, c) => n + (c.layout ?? 0), 0);

/** How much of the diff is left to read: files and changed lines before and after, and what hid the rest. */
export function statsOf(files: AnalyzedFile[]): Stats {
  const hidden = new Map<Noise, HiddenStats>();

  const slot = (k: Noise) => {
    const have = hidden.get(k) ?? { files: 0, blocks: 0, lines: 0 };

    hidden.set(k, have);

    return have;
  };

  let review = 0;
  let lines = 0;
  let reviewLines = 0;

  for (const f of files) {
    const cs = changes(f);
    lines += lineCount(cs) + layoutCount(cs);

    if (f.noise) {
      const h = slot(f.noise);
      h.files++;
      h.lines += lineCount(cs);
      continue;
    }

    if (layoutCount(cs)) slot(Noise.Format).lines += layoutCount(cs);

    for (const c of cs) {
      if (!c.noise) continue;

      const h = slot(c.noise);
      h.blocks++;
      h.lines += lineCount([c]);
    }

    if (showsFile(f)) {
      review++;
      reviewLines += lineCount(cs.filter(isSignal));
    }
  }

  return { files: files.length, review, lines, reviewLines, hidden };
}

const pct = (before: number, after: number) => (before ? `${Math.round((100 * (after - before)) / before)}%` : "-");

/** `overbridge diff --focused --stats`: the numbers behind the mini diff. */
export function renderStats(s: Stats): string {
  const rows = [`files  ${s.files} \u2192 ${s.review}  (${pct(s.files, s.review)})`, `lines  ${s.lines} \u2192 ${s.reviewLines}  (${pct(s.lines, s.reviewLines)})`];

  for (const [kind, h] of s.hidden) rows.push(`  ${kind.padEnd(10)} ${h.files ? `${h.files} file${h.files === 1 ? "" : "s"}, ` : ""}${h.blocks ? `${h.blocks} block${h.blocks === 1 ? "" : "s"}, ` : ""}${h.lines} lines`);

  return rows.join("\n");
}

/** The stats of a unified diff. */
export const focusedStats = (diffText: string, options: FocusOptions = {}): string => renderStats(statsOf(analyze(parseDiff(diffText), options)));
