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
    expect(a!.hunks[0]!.lines).toMatchObject([
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
    expect(noises(hunkDiff("a.go", [" import (", '+\t"fmt"', " )"]))).toEqual([Noise.Imports]);
    expect(noises(hunkDiff("A.java", ["+import java.util.List;"]))).toEqual([Noise.Imports]);
    expect(noises(hunkDiff("a.c", ["+#include <stdio.h>"]))).toEqual([Noise.Imports]);
    expect(noises(hunkDiff("a.ts", [" import {", "+  useState,", " } from 'react';"]))).toEqual([Noise.Imports]);
  });

  test("an import line mixed with code, or a lone member outside an import, is signal", () => {
    expect(noises(hunkDiff("a.ts", ['+import { a } from "x";', "+run(a);"]))).toEqual([undefined]);
    expect(noises(hunkDiff("a.ts", [" const o = {", "+  useState,", " };"]))).toEqual([undefined]);
  });

  const FILLER = [" k1", " k2", " k3", " k4", " k5", " k6", " k7"];
  const MOVED_LINES = ["function helper1(a: number) { return a * 1; }","function helper2(a: number) { return a * 2; }","function helper3(a: number) { return a * 3; }"];

  test("a run of lines that only moved within its file is hidden at both ends", () => {
    expect(noises(hunkDiff("a.ts", [...MOVED_LINES.map((l) => `-${l}`), ...FILLER, ...MOVED_LINES.map((l) => `+${l}`)]))).toEqual([Noise.Moved, Noise.Moved]);
  });

  test("a moved run does not hide a changed short line, an edit, a single line, or a duplicated copy", () => {
    const base = MOVED_LINES.map((l) => `-${l}`);
    const moved = MOVED_LINES.map((l) => `+${l}`);

    expect(noises(hunkDiff("a.ts", [...base, "-limit = 1", ...FILLER, ...moved]))[0]).toBeUndefined();
    expect(noises(hunkDiff("a.ts", ["-function helper(a: number) { return a * 2; }", " keep", "+function helper(a: number) { return a * 3; }"]))).toEqual([undefined, undefined]);
    expect(noises(hunkDiff("a.ts", [`-${MOVED_LINES[0]}`, ...FILLER, `+${MOVED_LINES[0]}`]))).toEqual([undefined, undefined]);
    expect(noises(hunkDiff("a.ts", [...base, ...FILLER, ...moved, ...FILLER, ...moved]))).toEqual([undefined, undefined, undefined]);
  });

  test("short generic lines are never moved", () => {
    expect(noises(hunkDiff("a.ts", ["-  return;", " x", "+  return;"]))).toEqual([undefined, undefined]);
  });

  test("quote style and semicolons are cosmetic only where the language says so", () => {
    expect(noises(hunkDiff("a.rs", ["-let c = 'a';", '+let c = "a";']))).toEqual([undefined]);
    expect(noises(hunkDiff("a.go", ["-r := 'a'", '+r := "a"']))).toEqual([undefined]);
    expect(noises(hunkDiff("a.sh", ["-echo '$HOME'", '+echo "$HOME"']))).toEqual([undefined]);
    expect(noises(hunkDiff("a.rs", ["-x", "+x;"]))).toEqual([undefined]);
    expect(noises(hunkDiff("a.py", ["-s = 'a'", '+s = "a"']))).toEqual([Noise.Format]);
    expect(noises(hunkDiff("a.ts", ["-s = 'a\"b'", '+s = "a"b"']))).toEqual([undefined]);
  });

  test("joining lines is signal when it comments code out or ends a statement early", () => {
    expect(noises(hunkDiff("a.ts", ["-check(user); // ok", "-deny();", "+check(user); // ok deny();"]))).toEqual([undefined]);
    expect(noises(hunkDiff("a.ts", ["-return", "-value;", "+return value;"]))).toEqual([undefined]);
    expect(noises(hunkDiff("a.ts", ["-a", "-(b)", "+a;", "+(b)"]))).toEqual([undefined]);
    expect(noises(hunkDiff("a.ts", ["-a + +b", "+a ++ b"]))).toEqual([undefined]);
  });

  test("star lines are comments only inside a comment", () => {
    expect(noises(hunkDiff("a.ts", [" total = base", "-  * 2", "+  * 3"]))).toEqual([undefined]);
    expect(noises(hunkDiff("a.ts", [" /**", " * a", "-* b", "+* c"]))).toEqual([Noise.Comments]);
    expect(noises(hunkDiff("a.ts", ["+/*", " code()", "+*/"]))).toEqual([undefined, undefined]);
  });

  test("code beside a comment, directives, empty statements and line endings are signal", () => {
    expect(noises(hunkDiff("a.ts", ["+/* t */ grantAdmin();"]))).toEqual([undefined]);
    expect(noises(hunkDiff("a.ts", ["+*/ grantAdmin(); /*"]))).toEqual([undefined]);
    expect(noises(hunkDiff("a.ts", ["+/* t */"]))).toEqual([Noise.Comments]);
    expect(noises(hunkDiff("a.sh", ["-#!/bin/sh", "+#!/bin/bash"]))).toEqual([undefined]);
    expect(noises(hunkDiff("a.go", ["-//go:build linux", "+//go:build windows"]))).toEqual([undefined]);
    expect(noises(hunkDiff("a.ts", ["-if (!ok);", "+if (!ok)", " foo();"]))).toEqual([undefined]);
    expect(noises(hunkDiff("a.sh", ["-set -e\r", "+set -e"]))).toEqual([undefined]);
    expect(noises(hunkDiff("a.ts", [" total = base", "   * rate", "-  * fee", "+  * 0"]))).toEqual([undefined]);
  });

  test("a moved run cannot take a deleted brace with it", () => {
    const run = MOVED_LINES.map((l) => `-${l}`);
    const back = MOVED_LINES.map((l) => `+${l}`);

    expect(noises(hunkDiff("a.ts", [...run, "-}", ...FILLER, ...back]))[0]).toBeUndefined();
  });

  test("bidi and zero-width characters never reach the output", () => {
    expect(focusedDiff(hunkDiff("a.ts", ["+const ok = 1; // \u202e\u200b"]))).not.toMatch(/[\u202e\u200b]/);
  });

  test("a rename with a mode change is not collapsed as a plain rename", () => {
    const text = ["diff --git a/o.sh b/n.sh", "old mode 100755", "new mode 100644", "similarity index 100%", "rename from o.sh", "rename to n.sh", ""].join("\n");
    expect(analyze(parseDiff(text)).map((f) => f.noise)).toEqual([Noise.Mode]);
  });

  test("a bare quoted line is an import only inside a Go import block", () => {
    expect(noises(hunkDiff("a.go", [" want := []string{", '-\t"alpha",', '+\t"beta",', " }"]))).toEqual([undefined]);
  });

  test("control characters and CRs in file text never reach the output", () => {
    const out = focusedDiff(hunkDiff("a.ts", ["+run(\u001b[8m1);\r"]));
    expect(out).not.toContain("\u001b[8m");
    expect(out).not.toContain("\r");
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
    expect(out).toContain("focused diff 1 of 3 files, 1 change");
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
    expect(out).toContain("focused diff 0 of 1 file, 0 changes · hidden: format 1");
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

  test("--keep renamed shows a pure rename; an all-noise rename collapses under both names", () => {
    const rename = ["diff --git a/o.ts b/n.ts", "similarity index 100%", "rename from o.ts", "rename to n.ts", ""].join("\n");
    expect(strip(focusedDiff(rename, { keep: new Set([Noise.Renamed]) }))).toContain("── n.ts (renamed from o.ts, 100%)");

    const noisy = ["diff --git a/o.ts b/n.ts", "similarity index 90%", "rename from o.ts", "rename to n.ts", "--- a/o.ts", "+++ b/n.ts", "@@ -1 +1 @@", "-foo(1)", "+foo(1);", ""].join("\n");
    expect(strip(focusedDiff(noisy))).toContain("o.ts → n.ts  format 1");
  });

  test("empty input renders nothing", () => {
    expect(focusedDiff("")).toBe("");
  });

  test("is deterministic", () => {
    expect(focusedDiff(text)).toBe(focusedDiff(text));
  });
});
