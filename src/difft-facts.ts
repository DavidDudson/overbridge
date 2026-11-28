/**
 * Asks difftastic (tree-sitter parsing for about fifty languages) which lines of a diff really changed, so
 * `overbridge diff --focused` need not guess at layout and comments with its own lexer. Any failure gives
 * undefined, and the caller falls back to the lexer for that file or for the whole diff.
 */
import type { FileFacts } from "./focused-diff";
import { isJsonObject, numberField, objectField, parseJson, stringField, type JsonObject, type JsonValue } from "./json";
import { spawnCwd } from "./util";

export interface Run {
  exitCode: number;
  stdout: string;
}

export type Exec = (cmd: string[], env: Record<string, string>) => Run;

const TIMEOUT_MS = 30_000;

const spawn: Exec = (cmd, env) => {
  const out = Bun.spawnSync({ cmd, cwd: spawnCwd(), env: { ...process.env, ...env }, stdout: "pipe", stderr: "ignore", timeout: TIMEOUT_MS });

  return { exitCode: out.exitCode ?? 1, stdout: out.stdout.toString() };
};

const array = (v: JsonValue | undefined): JsonValue[] => (Array.isArray(v) ? v : []);

interface Side {
  changed: Set<number>;
  comment: Set<number>;
}

/** One side of a row: the line is changed, and stays a comment line only while every changed token on it is one. */
function mark(side: Side, row: JsonObject, key: "lhs" | "rhs") {
  const at = objectField(row, key);
  const line = at && numberField(at, "line_number");

  if (line === undefined) return;

  const no = line + 1; // difftastic counts from 0
  const tokens = array(at?.changes).filter(isJsonObject);
  const onlyComments = tokens.length > 0 && tokens.every((t) => stringField(t, "highlight") === "comment");

  if (!side.changed.has(no)) side.comment.add(no);

  side.changed.add(no);

  if (!onlyComments) side.comment.delete(no);
}

/** The facts in one file's JSON, or undefined when difftastic fell back to plain text for it (no grammar, a parse error, too big). */
export function parseFacts(file: JsonObject): [string, FileFacts] | undefined {
  const path = stringField(file, "path");
  const language = stringField(file, "language");
  const status = stringField(file, "status");

  if (!path || !language || language.startsWith("Text") || (status !== "changed" && status !== "unchanged")) return undefined;

  const old: Side = { changed: new Set(), comment: new Set() };
  const now: Side = { changed: new Set(), comment: new Set() };

  for (const chunk of array(file.chunks)) {
    for (const row of array(chunk)) {
      if (!isJsonObject(row)) return undefined;

      mark(old, row, "lhs");
      mark(now, row, "rhs");
    }
  }

  return [path, { oldChanged: old.changed, newChanged: now.changed, oldComment: old.comment, newComment: now.comment }];
}

/** Reads difftastic's JSON, one object per line. */
export function parseFactsOutput(text: string): Map<string, FileFacts> {
  const facts = new Map<string, FileFacts>();

  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;

    try {
      const parsed = parseJson(line);
      const one = isJsonObject(parsed) ? parseFacts(parsed) : undefined;

      if (one) facts.set(one[0], one[1]);
    } catch {
      // a line that is not JSON says nothing about any file
    }
  }

  return facts;
}

/** What difftastic says about every changed file in `dir` against `base`; undefined when it is missing or fails. */
export function difftFacts(dir: string, base: string, exec: Exec = spawn, installed: boolean = !!Bun.which("difft")): Map<string, FileFacts> | undefined {
  if (!installed) return undefined;

  const out = exec(["git", "-C", dir, "-c", "core.quotepath=off", "diff", "--ext-diff", "--no-textconv", "--submodule=short", "--ignore-submodules=none", "-M", base, "--"], {
    GIT_EXTERNAL_DIFF: "difft",
    DFT_UNSTABLE: "yes",
    DFT_DISPLAY: "json",
  });

  return out.exitCode === 0 ? parseFactsOutput(out.stdout) : undefined;
}
