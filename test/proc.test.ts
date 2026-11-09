import { describe, expect, test } from "bun:test";
import { listProcs, parsePsLine, parseStat, pidAlive, readProc } from "../src/proc";

describe("parseStat (Linux /proc)", () => {
  test("reads state and parent, even when comm has spaces and parens", () => {
    expect(parseStat(7, "7 (bash) S 1 7 7 0 -1")).toEqual({ pid: 7, ppid: 1, comm: "bash", state: "S" });
    expect(parseStat(8, "8 (my (odd) name) Z 42 8 8 0 -1")).toEqual({ pid: 8, ppid: 42, comm: "my (odd) name", state: "Z" });
  });

  test("garbage is undefined", () => {
    expect(parseStat(1, "")).toBeUndefined();
    expect(parseStat(1, "1 bash S 1")).toBeUndefined();
  });
});

describe("parsePsLine (macOS ps)", () => {
  test("comm is a path on macOS: keep its basename, even with spaces in the path", () => {
    expect(parsePsLine("  4242     1 Ss   /Users/me/.local/bin/claude")).toEqual({ pid: 4242, ppid: 1, state: "Ss", comm: "claude" });
    expect(parsePsLine(" 99 4242 S+ /Applications/My Tool.app/Contents/MacOS/tool")).toEqual({ pid: 99, ppid: 4242, state: "S+", comm: "tool" });
  });

  test("login shells keep their leading dash for the caller to strip", () => {
    expect(parsePsLine("  10  1 Ss -zsh")?.comm).toBe("-zsh");
  });

  test("a blank or header line is undefined", () => {
    expect(parsePsLine("")).toBeUndefined();
    expect(parsePsLine("  PID  PPID STAT COMM")).toBeUndefined();
  });
});

describe("on this machine", () => {
  test("finds this process, its parent and a live pid, and not a dead one", () => {
    const me = readProc(process.pid);
    expect(me?.pid).toBe(process.pid);
    expect(me?.ppid).toBe(process.ppid);
    expect(listProcs().some((p) => p.pid === process.pid)).toBe(true);
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 - 1)).toBe(false);
  });
});
