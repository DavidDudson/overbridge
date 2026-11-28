import { describe, expect, test } from "bun:test";
import { analyze, focusedDiff, importTarget, Noise, parseDiff } from "../src/focused-diff";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** A one-hunk diff for `path` from raw body lines (each starting with ` `, `-` or `+`). */
function hunkDiff(path: string, body: string[]): string {
  const old = body.filter((l) => l[0] !== "+").length;
  const now = body.filter((l) => l[0] !== "-").length;

  return [`diff --git a/${path} b/${path}`, "index 111..222 100644", `--- a/${path}`, `+++ b/${path}`, `@@ -1,${old} +1,${now} @@`, ...body, ""].join("\n");
}

const noises = (diff: string) =>
  analyze(parseDiff(diff))
    .flatMap((f) => f.hunks.flatMap((h) => h.parts))
    .flatMap((p) => (p.context ? [] : [p.noise]));

describe("parseDiff", () => {
  test("reads files, statuses, renames and hunks by line count", () => {
    const text = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@ fn",
      "--- not a header",
      "+++ also content",
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "diff --git a/n.ts b/n.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/n.ts",
      "@@ -0,0 +1 @@",
      "+x",
      "",
    ].join("\n");

    const [a, r, n] = parseDiff(text);
    expect(a!.hunks[0]!.lines).toEqual([
      { kind: "-", text: "-- not a header" },
      { kind: "+", text: "++ also content" },
    ]);
    expect(r).toMatchObject({ status: "renamed", oldPath: "old.ts", path: "new.ts", similarity: 90 });
    expect(n).toMatchObject({ status: "added", path: "n.ts" });
  });
});

describe("noise classification", () => {
  test("formatting: whitespace, semicolons, trailing commas, quote style, reflow", () => {
    expect(noises(hunkDiff("a.ts", ["-const a = {b: 1, c: 'x'};", "+const a = {", '+  b: 1,', '+  c: "x",', "+};"]))).toEqual([Noise.Format]);
    expect(noises(hunkDiff("a.ts", ["-foo(a)", "+foo(a);"]))).toEqual([Noise.Format]);
    expect(noises(hunkDiff("a.ts", ["+", "+"]))).toEqual([Noise.Format]);
  });

  test("a real change is not formatting", () => {
    expect(noises(hunkDiff("a.ts", ["-foo(a)", "+foo(b)"]))).toEqual([undefined]);
    expect(noises(hunkDiff("a.ts", ["-let x = 1", "+letx = 1"]))).toEqual([undefined]);
  });

  test("indentation is meaning in Python and YAML", () => {
    expect(noises(hunkDiff("a.py", ["-    return 1", "+        return 1"]))).toEqual([undefined]);
    expect(noises(hunkDiff("a.ts", ["-    return 1", "+        return 1"]))).toEqual([Noise.Format]);
    expect(noises(hunkDiff("a.yml", ["-  a: 1", "+    a: 1"]))).toEqual([undefined]);
  });

  test("imports per language, including a member added inside multi-line braces", () => {
    expect(noises(hunkDiff("a.ts", ['-import { a } from "x";', '+import { a, b } from "x";']))).toEqual([Noise.Imports]);
    expect(noises(hunkDiff("a.ts", ["+import type { T } from './t'"]))).toEqual([Noise.Imports]);
    expect(noises(hunkDiff("a.ts", ["+const fs = require('fs');"]))).toEqual([Noise.Imports]);
    expect(noises(hunkDiff("a.py", ["+from os import path", "+import sys"]))).toEqual([Noise.Imports]);
    expect(noises(hunkDiff("a.rs", ["+use std::io;"]))).toEqual([Noise.Imports]);
    expect(noises(hunkDiff("a.go", ['+\t"fmt"']))).toEqual([Noise.Imports]);
    expect(noises(hunkDiff("A.java", ["+import java.util.List;"]))).toEqual([Noise.Imports]);
    expect(noises(hunkDiff("a.c", ["+#include <stdio.h>"]))).toEqual([Noise.Imports]);
    expect(noises(hunkDiff("a.ts", [" import {", "+  useState,", " } from 'react';"]))).toEqual([Noise.Imports]);
  });

  test("an import line mixed with code, or a lone member outside an import, is signal", () => {
    expect(noises(hunkDiff("a.ts", ['+import { a } from "x";', "+run(a);"]))).toEqual([undefined]);
    expect(noises(hunkDiff("a.ts", [" const o = {", "+  useState,", " };"]))).toEqual([undefined]);
  });

  test("code that only moved within its file is hidden at both ends; new code is not", () => {
    const moved = hunkDiff("a.ts", ["-function helper(a: number) { return a * 2; }", " keep", " keep2", " keep3", " keep4", " keep5", " keep6", " keep7", "+function helper(a: number) { return a * 2; }"]);
    expect(noises(moved)).toEqual([Noise.Moved, Noise.Moved]);

    const edited = hunkDiff("a.ts", ["-function helper(a: number) { return a * 2; }", " keep", "+function helper(a: number) { return a * 3; }"]);
    expect(noises(edited)).toEqual([undefined, undefined]);
  });

  test("short generic lines are never moved", () => {
    expect(noises(hunkDiff("a.ts", ["-  return;", " x", "+  return;"]))).toEqual([undefined, undefined]);
  });

  test("comments", () => {
    expect(noises(hunkDiff("a.ts", ["+// explain", "+/** doc */"]))).toEqual([Noise.Comments]);
    expect(noises(hunkDiff("a.py", ["+# explain"]))).toEqual([Noise.Comments]);
    expect(noises(hunkDiff("a.ts", ["+// explain", "+run();"]))).toEqual([undefined]);
  });

  test("`keep` shows a noise kind anyway", () => {
    const [f] = analyze(parseDiff(hunkDiff("a.ts", ["+// explain"])), { keep: new Set([Noise.Comments]) });
    const part = f!.hunks[0]!.parts[0]!;

    if (part.context) throw new Error("expected a change");
    expect(part.noise).toBeUndefined();
  });

  test("generated files, pure renames and mode changes are whole-file noise", () => {
    const text = [hunkDiff("bun.lock", ["-a", "+b"]), "diff --git a/o.ts b/n.ts", "similarity index 100%", "rename from o.ts", "rename to n.ts", "diff --git a/x.sh b/x.sh", "old mode 100644", "new mode 100755", ""].join("\n");
    expect(analyze(parseDiff(text)).map((f) => f.noise)).toEqual([Noise.Generated, Noise.Renamed, Noise.Mode]);
  });
});

describe("importTarget", () => {
  test("names the module", () => {
    expect(importTarget('import { a } from "zod";')).toBe("zod");
    expect(importTarget("from os import path")).toBe("os");
    expect(importTarget("use std::io;")).toBe("std::io");
    expect(importTarget("#include <stdio.h>")).toBe("stdio.h");
    expect(importTarget("  useState,")).toBe("useState");
  });
});

describe("renderFocused", () => {
  const text = [
    hunkDiff("src/a.ts", ['-import { a } from "lodash";', '+import { a } from "zod";', " ", "-const x = 1", "+const x = 2", " keep", "+// note"]),
    hunkDiff("bun.lock", ["-a", "+b"]),
    hunkDiff("src/fmt.ts", ["-foo(1)", "+foo(1);"]),
  ].join("");

  test("shows the signal, marks hidden blocks in place, and summarises the rest", () => {
    const out = strip(focusedDiff(text));
    expect(out).toContain("focused diff 1 file, 1 change");
    expect(out).toContain("hidden: imports 1 · comments 1 · generated 1 · format 1");
    expect(out).toContain("── src/a.ts +1 −1");
    expect(out).toContain("-const x = 1");
    expect(out).toContain("+const x = 2");
    expect(out).toContain("⋯ imports +zod −lodash");
    expect(out).toContain("⋯ comments +1 −0");
    expect(out).toMatch(/collapsed\n {2}bun\.lock {2}generated \+1 −1\n {2}src\/fmt\.ts {2}format 1/);
    expect(out).not.toContain("+foo(1);");
  });

  test("a diff that is all noise still reports it", () => {
    const out = strip(focusedDiff(hunkDiff("a.ts", ["-foo(1)", "+foo(1);"])));
    expect(out).toContain("focused diff 0 files, 0 changes · hidden: format 1");
  });

  test("a file with signal in one hunk and noise in another notes the hidden hunk", () => {
    const body = (n: number) => ["@@ -" + n + ",1 +" + n + ",1 @@", "-foo(1)", "+foo(1);"];
    const two = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,1 +1,1 @@", "-real()", "+changed()", ...body(40), ""].join("\n");
    expect(strip(focusedDiff(two))).toContain("⋯ also hidden: format 1");
  });

  test("added files are truncated", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `+line ${i}`);
    const diff = ["diff --git a/n.ts b/n.ts", "new file mode 100644", "--- /dev/null", "+++ b/n.ts", "@@ -0,0 +1,30 @@", ...lines, ""].join("\n");
    const out = strip(focusedDiff(diff));
    expect(out).toContain("── n.ts (added) +30 −0");
    expect(out).toContain("+line 19");
    expect(out).not.toContain("+line 20");
    expect(out).toContain("⋯ 10 more lines");
  });

  test("renamed with edits shows the rename and the edit", () => {
    const diff = ["diff --git a/o.ts b/n.ts", "similarity index 80%", "rename from o.ts", "rename to n.ts", "--- a/o.ts", "+++ b/n.ts", "@@ -1 +1 @@", "-a()", "+b()", ""].join("\n");
    expect(strip(focusedDiff(diff))).toContain("── n.ts (renamed from o.ts, 80%) +1 −1");
  });

  test("empty input renders nothing", () => {
    expect(focusedDiff("")).toBe("");
  });

  test("is deterministic", () => {
    expect(focusedDiff(text)).toBe(focusedDiff(text));
  });
});
