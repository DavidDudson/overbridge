import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadRepos } from "./config";
import { packageRoot } from "./paths";
import { parseYaml, rootConfigPath, rootLayersFrom, suggest } from "./project-config";
import { errorMessage, fail, isBoolean, isNumber, isRecord, isString, log, type Json, type JsonObject } from "./util";

/** The subset of JSON Schema that `config.schema.json` and `overbridge.schema.json` use to describe keys. */
export interface KeySchema {
  type?: string | string[];
  $ref?: string;
  const?: Json;
  enum?: Json[];
  properties?: Record<string, KeySchema>;
  patternProperties?: Record<string, KeySchema>;
  additionalProperties?: boolean | KeySchema;
  oneOf?: KeySchema[];
  anyOf?: KeySchema[];
  allOf?: KeySchema[];
  $defs?: Record<string, KeySchema>;
}

/** Root config paths whose value is a layer in `overbridge.yml`'s format. */
const isLayerPath = (path: readonly string[]) =>
  (path.length === 1 && path[0] === "defaults") || (path.length === 2 && (path[0] === "owners" || path[0] === "repos"));

const OPEN: KeySchema = {};

function resolveRef(schema: KeySchema, docs: readonly KeySchema[]): KeySchema {
  const name = schema.$ref?.match(/^#\/\$defs\/(.+)$/)?.[1];

  if (name === undefined) {
    return schema;
  }

  const target = docs.map((doc) => doc.$defs?.[name]).find((def) => def !== undefined);

  if (target === undefined) {
    throw new Error(`schema $ref ${schema.$ref} points at nothing`);
  }

  return resolveRef(target, docs);
}

/** `schema` and the branches of its oneOf/anyOf/allOf, with every $ref followed. */
function branches(schema: KeySchema, docs: readonly KeySchema[]): KeySchema[] {
  const node = resolveRef(schema, docs);

  return [node, ...[...(node.oneOf ?? []), ...(node.anyOf ?? []), ...(node.allOf ?? [])].flatMap((branch) => branches(branch, docs))];
}

/** A schema that says nothing about its value's shape accepts any key below it. */
const isOpen = (node: KeySchema) =>
  [node.type, node.$ref, node.const, node.enum, node.properties, node.patternProperties, node.additionalProperties, node.oneOf, node.anyOf, node.allOf].every(
    (part) => part === undefined,
  );

function childSchema(schema: KeySchema, key: string, docs: readonly KeySchema[]): KeySchema | undefined {
  const nodes = branches(schema, docs);

  const found = nodes
    .map(
      (node) =>
        node.properties?.[key] ??
        Object.entries(node.patternProperties ?? {}).find(([pattern]) => new RegExp(pattern).test(key))?.[1] ??
        (isRecord(node.additionalProperties) ? node.additionalProperties : undefined),
    )
    .find((child) => child !== undefined);

  if (found !== undefined) {
    return found;
  }

  return nodes.some(isOpen) ? OPEN : undefined;
}

const knownKeys = (schema: KeySchema, docs: readonly KeySchema[]) => branches(schema, docs).flatMap((node) => Object.keys(node.properties ?? {}));

/** A layer's schema: `overbridge.yml`'s keys plus the root-only keys the root schema lists for that layer. */
function layerSchema(rootNode: KeySchema, layer: KeySchema, docs: readonly KeySchema[]): KeySchema {
  const node = resolveRef(rootNode, docs);

  return {
    type: "object",
    properties: { ...layer.properties, ...node.properties },
    patternProperties: { ...layer.patternProperties, ...node.patternProperties },
    additionalProperties: false,
  };
}

/**
 * Why the root config schema does not know `path`, or undefined when it does. `rootSchema` is
 * `config.schema.json`; `layer` is `overbridge.schema.json`, which describes `defaults`, `owners.<owner>`
 * and `repos.<name>`.
 */
export function unknownKeyProblem(path: readonly string[], rootSchema: KeySchema, layer: KeySchema): string | undefined {
  const docs = [rootSchema, layer];

  const walk = (schema: KeySchema, depth: number): string | undefined => {
    if (depth === path.length || schema === OPEN) {
      return undefined;
    }

    const key = path[depth]!;
    const at = path.slice(0, depth).join(".");
    const child = childSchema(schema, key, docs);

    if (child === undefined) {
      const hint = suggest(key, knownKeys(schema, docs));
      const where = at ? ` under ${at}` : "";

      return `unknown key '${key}'${where}${hint ? ` (did you mean '${hint}'?)` : ""}`;
    }

    const consumed = path.slice(0, depth + 1);

    return walk(isLayerPath(consumed) ? layerSchema(child, layer, docs) : child, depth + 1);
  };

  return walk(rootSchema, 0);
}

/**
 * Read a value given on the command line. `[...]` and `{...}` are YAML flow collections; a number, `true`,
 * `false` or `null` written exactly so takes that type; anything else stays the string as typed, so a command
 * keeps a ` # ...` or `: ` and `1.10` stays `1.10`.
 */
export function parseConfigValue(text: string): Json {
  const trimmed = text.trim();

  try {
    const value = yamlJson(text);

    if (/^[[{]/.test(trimmed)) {
      return value ?? text;
    }

    return value === null ? (trimmed === "null" ? null : text) : isNumber(value) || isBoolean(value) ? (String(value) === trimmed ? value : text) : text;
  } catch {
    return text;
  }
}

// SAFETY: a YAML document parses to plain scalars, arrays and mappings, which is what `Json` describes.
const yamlJson = (text: string) => Bun.YAML.parse(text) as Json | undefined;

const parsesTo = (yaml: string, value: Json): boolean => {
  try {
    return Bun.deepEquals(Bun.YAML.parse(yaml), value);
  } catch {
    return false;
  }
};

/** `value` as YAML on one line: plain when that reads back the same, else JSON, which YAML reads as flow style. */
export function inlineYaml(value: Json): string {
  if (isString(value) && value !== "" && !/[\n\t]/.test(value) && parsesTo(`k: ${value}`, { k: value })) {
    return value;
  }

  return JSON.stringify(value);
}

const yamlKey = (key: string) => (/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(key) && parsesTo(`k: ${key}`, { k: key }) ? key : JSON.stringify(key));

const isContent = (line: string) => line.trim() !== "" && !line.trimStart().startsWith("#");

const isListItem = (line: string) => /^\s*-(\s|$)/.test(line);

const indentOf = (line: string) => line.length - line.trimStart().length;

interface ValueAndComment {
  value: string;
  /** The trailing comment with the whitespace before it, or "". */
  comment: string;
}

interface KeyLine extends ValueAndComment {
  indent: number;
  key: string;
  /** The text the key is written as, quotes included. */
  keyText: string;
}

/** Split `rest` into its value and a trailing `# comment`, ignoring `#` inside quotes. */
function splitComment(rest: string): ValueAndComment {
  const at = [...rest].reduce<{ quote: string; index: number }>(
    (state, ch, i) => {
      if (state.index >= 0) {
        return state;
      }

      if (state.quote) {
        return ch === state.quote ? { ...state, quote: "" } : state;
      }

      if (ch === '"' || ch === "'") {
        return { ...state, quote: ch };
      }

      return ch === "#" && (i === 0 || /\s/.test(rest[i - 1]!)) ? { ...state, index: i } : state;
    },
    { quote: "", index: -1 },
  ).index;

  if (at < 0) {
    return { value: rest.trim(), comment: "" };
  }

  const value = rest.slice(0, at).trimEnd();
  const lead = rest.slice(0, at).slice(value.length);

  return { value: value.trim(), comment: `${lead || " "}${rest.slice(at)}` };
}

function keyLine(line: string): KeyLine | undefined {
  const match = line.match(/^(\s*)("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"\-[{][^:#]*?|-[^\s:#][^:#]*?)\s*:(?:\s+(.*))?$/);

  if (!match) {
    return undefined;
  }

  const keyText = match[2]!;
  // SAFETY: the pattern matched a double-quoted YAML key, which is a JSON string literal for the keys config.yml holds.
  const key = keyText.startsWith('"') ? (JSON.parse(keyText) as string) : keyText.startsWith("'") ? keyText.slice(1, -1).replaceAll("''", "'") : keyText;

  return { indent: match[1]!.length, key, keyText, ...splitComment(match[3] ?? "") };
}

/** The index of the last line that belongs to the entry at `start` (its own line when it has no block). */
function blockEnd(lines: readonly string[], start: number, indent: number, end: number): number {
  const isChild = (line: string) => indentOf(line) > indent || (indentOf(line) === indent && isListItem(line));
  const next = lines.findIndex((line, i) => i > start && i < end && isContent(line) && !isChild(line));
  const stop = next < 0 ? end : next;
  const last = lines.slice(start + 1, stop).findLastIndex(isContent);

  return last < 0 ? start : start + 1 + last;
}

const EMPTY_VALUES = new Set(["", "~", "null", "{}"]);

const indentStepOf = (lines: readonly string[]) => {
  const indents = lines.flatMap((line) => (isContent(line) && indentOf(line) > 0 ? [indentOf(line)] : []));

  return indents.length ? Math.min(...indents) : 2;
};

function setIn(base: Json | undefined, path: readonly string[], value: Json): Json {
  if (!path.length) {
    return value;
  }

  const obj: JsonObject = isRecord(base) ? base : {};

  return { ...obj, [path[0]!]: setIn(obj[path[0]!], path.slice(1), value) };
}

/**
 * Set `path` to `value` in the YAML `text`, keeping every other line (comments and layout included). Edits
 * block mappings only; throws when the path runs through a list, a flow mapping or a scalar, or when the result
 * would change anything but `path`.
 */
export function setYamlValue(text: string, path: readonly string[], value: Json): string {
  if (!path.length || path.some((segment) => segment === "")) {
    throw new Error(`'${path.join(".")}' is not a key: use dotted names such as defaults.ide`);
  }

  if (text.includes("\r")) {
    throw new Error("the file has CRLF line endings; convert it to LF or edit it by hand");
  }

  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const docMarkers = lines.flatMap((line, i) => (/^---(\s|$)/.test(line) ? [i] : []));

  if (docMarkers.length > 1 || (docMarkers.length === 1 && lines.slice(0, docMarkers[0]).some(isContent))) {
    throw new Error("the file holds more than one YAML document; edit it by hand");
  }

  const indentStep = indentStepOf(lines);
  const valueText = inlineYaml(value);

  const edit = (lines: readonly string[], start: number, end: number, parentIndent: number, depth: number, parentPath: string): string[] => {
    const segment = path[depth]!;
    const keyPath = parentPath ? `${parentPath}.${segment}` : segment;
    const contentIndexes = lines.flatMap((line, i) => (i >= start && i < end && isContent(line) && !/^(---|\.\.\.|%)/.test(line) ? [i] : []));
    const childIndent = contentIndexes.length ? Math.min(...contentIndexes.map((i) => indentOf(lines[i]!))) : parentIndent;
    const atChildIndent = contentIndexes.filter((i) => indentOf(lines[i]!) === childIndent);

    // an indentless list (`key:` then `- item` at the same indent) belongs to the key above it
    if (atChildIndent.length && isListItem(lines[atChildIndent[0]!]!)) {
      throw new Error(`${parentPath || "the file"} is a list, not a block mapping (line ${atChildIndent[0]! + 1}); edit it by hand`);
    }

    const entries = atChildIndent.filter((i) => !isListItem(lines[i]!));

    const parsed = entries.map((i) => {
      const line = keyLine(lines[i]!);

      if (line === undefined) {
        throw new Error(`${parentPath || "the file"} is not a block mapping (line ${i + 1}); edit it by hand`);
      }

      return { i, line };
    });

    const found = parsed.find((entry) => entry.line.key === segment);

    if (found === undefined) {
      const added = path.slice(depth).map((key, n) => {
        const pad = " ".repeat(childIndent + n * indentStep);

        return n === path.length - depth - 1 ? `${pad}${yamlKey(key)}: ${valueText}` : `${pad}${yamlKey(key)}:`;
      });

      const at = contentIndexes.length ? contentIndexes.at(-1)! + 1 : end;

      return [...lines.slice(0, at), ...added, ...lines.slice(at)];
    }

    const { line } = found;
    const last = blockEnd(lines, found.i, childIndent, end);
    const pad = " ".repeat(line.indent);

    if (depth === path.length - 1) {
      return [...lines.slice(0, found.i), `${pad}${line.keyText}: ${valueText}${line.comment}`, ...lines.slice(last + 1)];
    }

    if (!EMPTY_VALUES.has(line.value)) {
      throw new Error(`${keyPath} is written inline as '${line.value}', not as a block mapping; edit it by hand`);
    }

    const rewritten = line.value === "" ? lines : lines.with(found.i, `${pad}${line.keyText}:${line.comment}`);

    return edit(rewritten, found.i + 1, last + 1, childIndent + indentStep, depth + 1, keyPath);
  };

  const result = `${edit(lines, docMarkers.length ? docMarkers[0]! + 1 : 0, lines.length, 0, 0, "").join("\n")}\n`;
  const before = text.trim() === "" ? undefined : yamlJson(text);

  if (!parsesTo(result, setIn(before ?? {}, path, value))) {
    throw new Error(`could not set ${path.join(".")} without changing other keys; edit the file by hand`);
  }

  return result;
}

function readSchema(name: string): KeySchema {
  // SAFETY: the schema files ship with the package and are JSON Schema documents.
  return JSON.parse(readFileSync(join(packageRoot(), name), "utf8")) as KeySchema;
}

/** `overbridge config set <key> <value> [--repo name]`: write one value to the root `config.yml`. */
export function configSet(key: string, valueText: string, repo?: string) {
  const path = [...(repo === undefined ? [] : ["repos", repo]), ...key.split(".")];
  const problem = unknownKeyProblem(path, readSchema("config.schema.json"), readSchema("overbridge.schema.json"));
  const shown = path.join(".");

  if (problem) {
    fail(`${shown}: ${problem}. See config.schema.json for the keys config.yml takes.`);
  }

  if (repo !== undefined && !isKnownRepo(repo)) {
    log(`warning: '${repo}' is not in repos.toml, so repos.${repo} applies to nothing yet`);
  }

  const file = configFileToWrite();
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  const value = parseConfigValue(valueText);
  const after = editedOrFail(file, before, path, value);

  try {
    rootLayersFrom(parseYaml(after, file), file);
  } catch (e) {
    fail(`not written: ${errorMessage(e)}`);
  }

  const tmp = `${file}.${process.pid}.tmp`;
  // keep a file the user restricted (0600) restricted after the rename
  writeFileSync(tmp, after, existsSync(file) ? { mode: statSync(file).mode & 0o777 } : {});
  renameSync(tmp, file);
  log(`${file}: ${shown} = ${JSON.stringify(value)}`);
}

/** The root config.yml, through any symlink so the rename replaces its target, not the link. */
function configFileToWrite(): string {
  const file = rootConfigPath();

  if (!existsSync(dirname(file))) {
    fail(`${dirname(file)} does not exist; run overbridge init first`);
  }

  return existsSync(file) ? realpathSync(file) : file;
}

function editedOrFail(file: string, text: string, path: readonly string[], value: Json): string {
  try {
    return setYamlValue(text, path, value);
  } catch (e) {
    fail(`${file}: ${errorMessage(e)}`);
  }
}

function isKnownRepo(repo: string): boolean {
  try {
    return loadRepos()[repo] !== undefined;
  } catch (e) {
    log(`warning: could not read repos.toml to check '${repo}': ${errorMessage(e)}`);

    return true;
  }
}
