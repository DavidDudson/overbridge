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
}

export const NOISE_KINDS: readonly string[] = Object.values(Noise);

export const isNoise = (s: string): s is Noise => NOISE_KINDS.includes(s);

export interface DiffLine {
  kind: " " | "+" | "-";
  text: string;
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
}

export type Part = Context | Change;

export interface AnalyzedHunk {
  header: string;
  parts: Part[];
}

export interface AnalyzedFile extends Omit<FileDiff, "hunks"> {
  /** Set when the whole file is noise. */
  noise?: Noise;
  hunks: AnalyzedHunk[];
}

export interface FocusOptions {
  /** Noise kinds to show anyway. */
  keep?: ReadonlySet<Noise>;
  /** Added or deleted files print this many lines, then a count. */
  maxWholeFileLines?: number;
}

/** A line from a file, safe to print: CR dropped (CRLF reads as LF), other control characters (ESC could recolour or hide output) replaced. */
const clean = (line: string) => line.replace(/\r$/, "").replace(/(?![\t])\p{Cc}/gu, "\uFFFD");

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
      const hunk: Hunk = { header: l, lines: [] };

      while ((oldLeft > 0 || newLeft > 0) && i + 1 < lines.length) {
        const b = lines[i + 1]!;
        const k = b === "" ? " " : b[0];

        if (k === " ") {
          oldLeft--;
          newLeft--;
          hunk.lines.push({ kind: " ", text: clean(b.slice(1)) });
        } else if (k === "-") {
          oldLeft--;
          hunk.lines.push({ kind: "-", text: clean(b.slice(1)) });
        } else if (k === "+") {
          newLeft--;
          hunk.lines.push({ kind: "+", text: clean(b.slice(1)) });
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

const isGenerated = (path: string) => GENERATED.some((re) => re.test(path));

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
const CONTINUES = /^\s*[([`+\-/*.]/;

function formatOnly(removed: readonly string[], added: readonly string[], next: string, lang: Lang): boolean {
  const sameLines = removed.length === added.length;

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

function analyzeHunk(file: FileDiff, hunk: Hunk, lang: Lang, removedPool: Pool, addedPool: Pool, keep: ReadonlySet<Noise>): AnalyzedHunk {
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

    const removed: string[] = [];
    const added: string[] = [];

    for (; i < lines.length && lines[i]!.kind !== " "; i++) (lines[i]!.kind === "-" ? removed : added).push(lines[i]!.text);

    const change: Change = { removed, added };
    const wholeFile = file.status === "added" || file.status === "deleted";
    const noise = wholeFile ? undefined : classify(removed, added, lines[i]?.text ?? "", seen, lang, removedPool, addedPool);

    if (noise && !keep.has(noise)) change.noise = noise;
    parts.push(change);
    seen.push(...added);
  }

  return { header: hunk.header, parts };
}

const STAR_LINE = /^\*(\s|$)/;

/** True when every line is a comment and each `/*` closes inside the block; `*` lines count only inside a comment. */
function onlyComments(real: readonly string[], before: readonly string[], lang: Lang): boolean {
  if (!real.length) return false;

  const opens = real.filter((l) => l.includes("/*")).length;
  const closes = real.filter((l) => l.includes("*/")).length;

  if (lang.block && opens !== closes) return false;

  const last = before.findLast((l) => l.trim())?.trim() ?? "";
  const inBlock = last.startsWith("/*") ? !last.includes("*/") : STAR_LINE.test(last);
  const starOk = !!lang.block && (inBlock || real.some((l) => l.trim().startsWith("/*")));

  return real.every((l) => lang.comment.test(l.trim()) || (starOk && STAR_LINE.test(l.trim())));
}

function classify(removed: string[], added: string[], next: string, before: readonly string[], lang: Lang, removedPool: Pool, addedPool: Pool): Noise | undefined {
  if (formatOnly(removed, added, next, lang)) return Noise.Format;

  if (onlyImports([...removed, ...added], before, lang)) return Noise.Imports;

  // every line with a word in it must keep its count across the file, so a short changed line is never hidden with a moved one
  const keys = nonBlank([...removed, ...added]).map((l) => lineKey(l, lang)).filter((k) => /\w/.test(k));
  const moved = keys.length > 0 && keys.every((k) => (removedPool.get(k) ?? 0) === (addedPool.get(k) ?? 0));

  if (moved && keys.filter((k) => k.length >= MOVED_MIN_KEY).length >= MOVED_MIN_LINES) return Noise.Moved;

  if (onlyComments(nonBlank([...removed, ...added]), before, lang)) return Noise.Comments;
}

/** Tags the noise in each file. Whole-file noise first (generated, rename, mode), then block by block. */
export function analyze(files: FileDiff[], options: FocusOptions = {}): AnalyzedFile[] {
  const keep = options.keep ?? new Set<Noise>();

  return files.map((file): AnalyzedFile => {
    const lang = langOf(file.path);
    const unlessKept = (kind: Noise) => (keep.has(kind) ? undefined : kind);
    const noHunks: AnalyzedHunk[] = [];
    const base = { ...file, hunks: noHunks };

    if (isGenerated(file.path) && !file.binary) return { ...base, noise: unlessKept(Noise.Generated), hunks: analyzeAll(file, lang, new Map(), new Map(), keep) };

    if (!file.hunks.length && !file.binary) {
      if (file.status === "renamed") return { ...base, noise: unlessKept(Noise.Renamed) };

      if (file.modeChange) return { ...base, noise: unlessKept(Noise.Mode) };
    }

    const removedPool: Pool = new Map();
    const addedPool: Pool = new Map();

    for (const h of file.hunks) {
      for (const l of h.lines) if (l.kind !== " " && l.text.trim()) bump(l.kind === "-" ? removedPool : addedPool, lineKey(l.text, lang));
    }

    return { ...base, hunks: analyzeAll(file, lang, removedPool, addedPool, keep) };
  });
}

const analyzeAll = (file: FileDiff, lang: Lang, removedPool: Pool, addedPool: Pool, keep: ReadonlySet<Noise>) =>
  file.hunks.map((h) => analyzeHunk(file, h, lang, removedPool, addedPool, keep));

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

      for (const l of [...head, ...tail]) out.push(` ${l}`);
    } else if (p.noise) {
      out.push(`${DIM} ${marker(p, p.noise)}${RESET}`);
    } else {
      for (const l of p.removed) out.push(`${RED}-${l}${RESET}`);

      for (const l of p.added) out.push(`${GREEN}+${l}${RESET}`);
    }
  });

  return out;
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
      collapsed.push(`  ${name}  ${f.noise}${added + removed ? ` +${added} −${removed}` : ""}`);
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
    const tag = f.status === "modified" ? "" : f.status === "renamed" ? ` (renamed from ${f.oldPath}${f.similarity !== undefined ? `, ${f.similarity}%` : ""})` : ` (${f.status})`;
    body.push(`${BOLD}── ${f.path}${RESET}${DIM}${tag} ${RESET}${GREEN}+${shown.added}${RESET} ${RED}−${shown.removed}${RESET}`);

    if (f.binary) body.push(`${DIM} binary file differs${RESET}`);

    if (f.status === "added" || f.status === "deleted") {
      const sign = f.status === "added" ? "+" : "-";
      const color = f.status === "added" ? GREEN : RED;
      const lines = cs.flatMap((c) => (f.status === "added" ? c.added : c.removed));

      for (const l of lines.slice(0, maxWhole)) body.push(`${color}${sign}${l}${RESET}`);

      if (lines.length > maxWhole) body.push(`${DIM} ⋯ ${lines.length - maxWhole} more lines${RESET}`);
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

  const summary = `${BOLD}focused diff${RESET} ${CYAN}${shownFiles} file${shownFiles === 1 ? "" : "s"}, ${shownChanges} change${shownChanges === 1 ? "" : "s"}${RESET}${hidden.size ? `${DIM} · hidden: ${tally(hidden)}${RESET}` : ""}`;
  const tail = collapsed.length ? [`${DIM}collapsed${RESET}`, ...collapsed.map((l) => `${DIM}${l}${RESET}`), ""] : [];

  return [summary, "", ...body, ...tail].join("\n");
}

/** Unified diff text in, mini diff out. */
export const focusedDiff = (diffText: string, options: FocusOptions = {}): string => renderFocused(analyze(parseDiff(diffText), options), options);
