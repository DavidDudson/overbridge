import { describe, expect, test } from "bun:test";
import { difftFacts, parseFactsOutput } from "../src/difft-facts";
import { analyze, type FileFacts, focusedDiff, Noise, parseDiff, renderStats, statsOf } from "../src/focused-diff";
import type { JsonObject } from "../src/json";
import { validateConfig } from "../src/project-config";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** A one-hunk diff for `path` from raw body lines (each starting with ` `, `-` or `+`). */
function hunkDiff(path: string, body: string[], mode = ""): string {
  const old = body.filter((l) => l[0] !== "+").length;
  const now = body.filter((l) => l[0] !== "-").length;
  const head = mode ? [mode] : [];

  return [`diff --git a/${path} b/${path}`, ...head, "index 111..222 100644", `--- a/${path}`, `+++ b/${path}`, `@@ -1,${old} +1,${now} @@`, ...body, ""].join("\n");
}

const facts = (over: Partial<Record<keyof FileFacts, number[]>>): FileFacts => ({
  oldChanged: new Set(over.oldChanged),
  newChanged: new Set(over.newChanged),
  oldComment: new Set(over.oldComment),
  newComment: new Set(over.newComment),
});

const noisesWith = (diff: string, f: FileFacts, path = "a.ts") =>
  analyze(parseDiff(diff), { facts: new Map([[path, f]]) })
    .flatMap((file) => file.hunks.flatMap((h) => h.parts))
    .flatMap((p) => (p.context ? [] : [p.noise]));

describe("line numbers", () => {
  test("each line carries its number on its own side", () => {
    const text = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -10,3 +20,3 @@", " keep", "-gone", "+came", " tail", ""].join("\n");
    const lines = parseDiff(text)[0]!.hunks[0]!.lines;

    expect(lines.map((l) => [l.kind, l.no])).toEqual([[" ", 20], ["-", 11], ["+", 21], [" ", 22]]);
  });
});

describe("difftastic facts", () => {
  const json = (file: JsonObject) => `${JSON.stringify(file)}\n`;

  const row = (lhs: number, rhs: number, highlight: string) => ({
    lhs: { line_number: lhs, changes: [{ content: "x", highlight }] },
    rhs: { line_number: rhs, changes: [{ content: "y", highlight }] },
  });

  test("reads changed and comment-only lines, one-based", () => {
    const out = json({ path: "a.ts", language: "TypeScript", status: "changed", chunks: [[row(2, 1, "comment"), row(4, 3, "normal")]] });
    const got = parseFactsOutput(out).get("a.ts")!;

    expect([...got.oldChanged]).toEqual([3, 5]);
    expect([...got.newChanged]).toEqual([2, 4]);
    expect([...got.oldComment]).toEqual([3]);
    expect([...got.newComment]).toEqual([2]);
  });

  test("a file difftastic read as plain text, or a line that is not JSON, gives nothing", () => {
    const text = json({ path: "a.html", language: "Text (4 HTML parse errors)", status: "changed", chunks: [] }) + "not json\n{broken\n";

    expect(parseFactsOutput(text).size).toBe(0);
  });

  test("an unchanged file has no changed lines", () => {
    const got = parseFactsOutput(json({ path: "a.ts", language: "TypeScript", status: "unchanged", chunks: [] })).get("a.ts")!;

    expect(got.newChanged.size).toBe(0);
  });

  test("runs git with difftastic as the external diff, and gives nothing when it is missing or fails", () => {
    const seen: { cmd: string[]; env: Record<string, string> }[] = [];

    const ok = (cmd: string[], env: Record<string, string>) => {
      seen.push({ cmd, env });

      return { exitCode: 0, stdout: json({ path: "a.ts", language: "TypeScript", status: "unchanged", chunks: [] }) };
    };

    expect(difftFacts("/r", "abc", ok, true)?.has("a.ts")).toBe(true);
    expect(seen[0]!.env).toMatchObject({ GIT_EXTERNAL_DIFF: "difft", DFT_DISPLAY: "json" });
    expect(seen[0]!.cmd).toContain("--ext-diff");
    expect(difftFacts("/r", "abc", ok, false)).toBeUndefined();
    expect(difftFacts("/r", "abc", () => ({ exitCode: 1, stdout: "" }), true)).toBeUndefined();
  });
});

describe("a syntax-aware verdict", () => {
  test("no changed line in a block means only layout moved", () => {
    expect(noisesWith(hunkDiff("a.ts", ["-foo(a)", "+bar(a)"]), facts({}))).toEqual([Noise.Format]);
  });

  test("a changed line stays signal, even one the lexer would call a comment", () => {
    const diff = hunkDiff("a.ts", ["-// a", "+// b"]);

    expect(noisesWith(diff, facts({ oldChanged: [1], newChanged: [1] }))).toEqual([undefined]);
    expect(noisesWith(diff, facts({ oldChanged: [1], newChanged: [1], oldComment: [1], newComment: [1] }))).toEqual([Noise.Comments]);
  });

  test("a tool directive is not a comment edit", () => {
    const diff = hunkDiff("a.ts", ["-// eslint-disable-next-line a", "+// eslint-disable-next-line b"]);

    expect(noisesWith(diff, facts({ oldChanged: [1], newChanged: [1], oldComment: [1], newComment: [1] }))).toEqual([undefined]);
  });

  test("a file with no facts is judged by the lexer", () => {
    expect(noisesWith(hunkDiff("b.ts", ["-// a", "+// b"]), facts({}), "a.ts")).toEqual([Noise.Comments]);
  });
});

describe("new test files and generated files", () => {
  const added = (path: string, lines: string[]) =>
    [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), ""].join("\n");

  test("an added test or story file is hidden, a changed one is not, and keep shows it", () => {
    const text = added("libs/a/a.spec.ts", ["it('x', () => {})"]);

    expect(analyze(parseDiff(text)).map((f) => f.noise)).toEqual([Noise.Tests]);
    expect(analyze(parseDiff(added("a/b.stories.ts", ["x"]))).map((f) => f.noise)).toEqual([Noise.Tests]);
    expect(analyze(parseDiff(text), { keep: new Set([Noise.Tests]) }).map((f) => f.noise)).toEqual([undefined]);
    expect(analyze(parseDiff(hunkDiff("libs/a/a.spec.ts", ["-it('x')", "+it('y')"]))).map((f) => f.noise)).toEqual([undefined]);
  });

  test("configured globs mark generated files", () => {
    const text = added("libs/f/src/tokens/primitives.tokens.json", ["{}"]);

    expect(analyze(parseDiff(text), { generated: ["libs/**/*.tokens.json"] }).map((f) => f.noise)).toEqual([Noise.Generated]);
    expect(analyze(parseDiff(text)).map((f) => f.noise)).toEqual([undefined]);
  });

  test("a header the file already had marks it generated; one the diff adds proves nothing", () => {
    const old = hunkDiff("src/a.ts", [" // @generated by tool", "-const a = 1", "+const a = 2"]);
    const forged = hunkDiff("src/a.ts", ["+// @generated by tool", "-const a = 1", "+const a = 2"]);

    expect(analyze(parseDiff(old)).map((f) => f.noise)).toEqual([Noise.Generated]);
    expect(analyze(parseDiff(forged)).map((f) => f.noise)).toEqual([undefined]);
  });

  test("a marker past the first lines is not a header", () => {
    const body = [...Array.from({ length: 12 }, (_, i) => ` line${i}`), " // @generated", "-a", "+b"];

    expect(analyze(parseDiff(hunkDiff("a.ts", body))).map((f) => f.noise)).toEqual([undefined]);
  });
});

describe("an added file's outline", () => {
  const added = (path: string, lines: string[]) =>
    [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), ""].join("\n");

  test("a long file shows its declarations and members, not its imports, bodies or closers", () => {
    const body = [
      "import { a } from 'a';",
      "import {",
      "  b,",
      "} from 'b';",
      "",
      "// note",
      "export class Table {",
      "  rows() {",
      "    const deep = 1;",
      "    return deep;",
      "  }",
      "}",
      ...Array.from({ length: 30 }, (_, i) => `    body${i}();`),
    ];

    const out = strip(focusedDiff(added("src/t.ts", body)));

    expect(out).toContain("+export class Table {");
    expect(out).toContain("+  rows() {");
    expect(out).not.toContain("import");
    expect(out).not.toContain("deep");
    expect(out).not.toContain("body1()");
    expect(out).toMatch(/⋯ \d+ more lines \(outline\)/);
  });

  test("a short file prints whole", () => {
    const out = strip(focusedDiff(added("src/t.ts", ["const a = 1;", "    nested();"])));

    expect(out).toContain("+    nested();");
    expect(out).not.toContain("more lines");
  });
});

describe("layout-only lines inside a real change", () => {
  test("lines difftastic did not report are dropped and counted", () => {
    const diff = hunkDiff("a.ts", ["-foo(a,", "-  b)", "-const x = 1", "+foo(a, b)", "+const x = 2"]);
    const [file] = analyze(parseDiff(diff), { facts: new Map([["a.ts", facts({ oldChanged: [3], newChanged: [2] })]]) });
    const change = file!.hunks[0]!.parts[0]!;

    expect(change).toMatchObject({ removed: ["const x = 1"], added: ["const x = 2"], layout: 3 });
    expect(strip(focusedDiff(diff, { facts: new Map([["a.ts", facts({ oldChanged: [3], newChanged: [2] })]]) }))).toContain("format 3 more lines re-indented or reflowed");
  });
});

describe("the same change in many files", () => {
  const file = (path: string, body: string[]) => hunkDiff(path, body);
  const edit = ["-const a = 1", "+const a = 2"];

  test("three files with the same edit show it once and list the rest", () => {
    const text = [file("a.ts", edit), file("b.ts", edit), file("c.ts", edit), file("d.ts", ["-x", "+y"])].join("");
    const files = analyze(parseDiff(text));

    expect(files.map((f) => f.noise)).toEqual([undefined, Noise.Repeated, Noise.Repeated, undefined]);
    expect(files[0]!.repeats).toEqual(["b.ts", "c.ts"]);
    expect(files[1]!.sameAs).toBe("a.ts");

    const out = strip(focusedDiff(text));

    expect(out).toContain("focused diff 2 of 4 files");
    expect(out).toContain("(the same change in 2 more files, listed below)");
    expect(out).toContain("b.ts  repeated of a.ts +1 −1");
  });

  test("two files are not a group, a different edit is not the same, and keep shows every file", () => {
    expect(analyze(parseDiff([file("a.ts", edit), file("b.ts", edit)].join(""))).map((f) => f.noise)).toEqual([undefined, undefined]);

    const mixed = [file("a.ts", edit), file("b.ts", edit), file("c.ts", ["-const a = 1", "+const a = 3"])].join("");

    expect(analyze(parseDiff(mixed)).map((f) => f.noise)).toEqual([undefined, undefined, undefined]);

    const three = [file("a.ts", edit), file("b.ts", edit), file("c.ts", edit)].join("");

    expect(analyze(parseDiff(three), { keep: new Set([Noise.Repeated]) }).map((f) => f.noise)).toEqual([undefined, undefined, undefined]);
  });
});

describe("stats", () => {
  test("files and lines before and after, and what hid the rest", () => {
    const text = [
      hunkDiff("src/real.ts", ["-const a = 1", "+const a = 2"]),
      hunkDiff("src/fmt.ts", ["-foo(1)", "+foo(1);"]),
      hunkDiff("bun.lock", ["-a", "+b"]),
    ].join("");

    const stats = statsOf(analyze(parseDiff(text)));

    expect(stats).toMatchObject({ files: 3, review: 1, lines: 6, reviewLines: 2 });
    expect(stats.hidden.get(Noise.Format)).toMatchObject({ blocks: 1, lines: 2 });
    expect(stats.hidden.get(Noise.Generated)).toMatchObject({ files: 1, lines: 2 });
    expect(renderStats(stats)).toContain("files  3 → 1  (-67%)");
  });
});

describe("diff config", () => {
  test("generated globs come from the root config only", () => {
    expect(validateConfig({ diff: { generated: ["a/**"] } }, "config.yml", { root: true }).diff.generated).toEqual(["a/**"]);
    expect(() => validateConfig({ diff: { generated: ["a/**"] } }, "overbridge.yml")).toThrow(/only allowed in the root config/);
    expect(() => validateConfig({ diff: { nope: [] } }, "config.yml", { root: true })).toThrow(/nope/);
  });
});
