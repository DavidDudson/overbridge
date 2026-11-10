import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKey, envDiff, leadingProgram, parseEnv0, resolveEnv, shellInvocation, type ShellDeps } from "../src/shell";
import type { ShellSpec } from "../src/project-config";

const spec = (extra: Partial<ShellSpec> = {}): ShellSpec => ({ enter: "wrap", key: [], ...extra });

const readIfExists = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : undefined);

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/**
 * Deps with an in-memory store for the repo's key files, a real temp dir as the cache, and a counter of
 * captures. A path under the cache dir reads from disk; any other from the store.
 */
function fake(files: Record<string, string> = {}, captured = "FOO=bar\0PATH=/x\0", onPath = (_: string) => true) {
  const store = { ...files };
  const state = { captures: 0, warnings: [] as string[] };
  const cache = mkdtempSync(join(tmpdir(), "shell-cache-"));
  dirs.push(cache);
  const deps: ShellDeps = {
    capture: () => {
      state.captures++;
      return captured;
    },
    read: (file) => (file.startsWith(cache) ? readIfExists(file) : store[file]),
    cacheDir: () => cache,
    base: () => ({ PATH: "/usr/bin", HOME: "/h" }),
    has: onPath,
    warn: (msg) => state.warnings.push(msg),
  };
  return { deps, store, state };
}

describe("parseEnv0 and envDiff", () => {
  test("parses NUL-separated pairs, keeping '=' inside values, dropping junk", () => {
    expect(parseEnv0("A=1\0B=x=y\0NOEQ\0=bad\0")).toEqual({ A: "1", B: "x=y" });
  });

  test("keeps only new or changed variables, and not the capturing shell's own", () => {
    const after = { HOME: "/h", PATH: "/n:/usr/bin", NEW: "1", PWD: "/somewhere", SHLVL: "2" };
    expect(envDiff({ HOME: "/h", PATH: "/usr/bin" }, after)).toEqual({ PATH: "/n:/usr/bin", NEW: "1" });
  });
});

describe("cacheKey", () => {
  const read = (files: Record<string, string>) => (f: string) => files[f];

  test("changes with a key file's contents, a missing file appearing, the dir and the config", () => {
    const s = spec({ env: "e", key: ["flake.lock"] });
    const base = cacheKey("/r", s, read({ "/r/flake.lock": "a" }));
    expect(cacheKey("/r", s, read({ "/r/flake.lock": "a" }))).toBe(base);
    expect(cacheKey("/r", s, read({ "/r/flake.lock": "b" }))).not.toBe(base);
    expect(cacheKey("/r", s, read({}))).not.toBe(base);
    expect(cacheKey("/other", s, read({ "/other/flake.lock": "a" }))).not.toBe(base);
    expect(cacheKey("/r", { ...s, enter: "other" }, read({ "/r/flake.lock": "a" }))).not.toBe(base);
  });

  test("ignores files that are not listed", () => {
    const s = spec({ env: "e", key: ["a"] });
    expect(cacheKey("/r", s, read({ "/r/a": "1", "/r/b": "1" }))).toBe(cacheKey("/r", s, read({ "/r/a": "1", "/r/b": "2" })));
  });
});

describe("shellInvocation", () => {
  test("no shell runs the command as it is", () => {
    expect(shellInvocation("app", "/r", undefined, ["ls", "-l"], "/r/sub")).toEqual({ cmd: ["ls", "-l"], cwd: "/r/sub", env: {} });
  });

  test("a prefix runs where the config lives, then moves to the wanted cwd", () => {
    const inv = shellInvocation("app", "/r", spec({ enter: "nix develop --command" }), ["just", "test"], "/ws", fake().deps);
    expect(inv.cwd).toBe("/r");
    expect(inv.env).toEqual({});
    expect(inv.cmd.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(inv.cmd[2]).toStartWith("nix develop --command sh -c ");
    expect(inv.cmd.slice(4)).toEqual(["/ws", "just", "test"]);
  });

  test("a prefix passes arguments through untouched", () => {
    const p = Bun.spawnSync({
      cmd: [...shellInvocation("app", "/tmp", spec({ enter: "env FOO=1" }), ["sh", "-c", 'echo "$FOO $1 $PWD"', "x", "a b"], "/").cmd],
      cwd: "/tmp",
      stdout: "pipe",
    });
    expect(p.stdout.toString().trim()).toBe("1 a b /");
  });

  test("with env, the command runs directly with the cached env", () => {
    const f = fake();
    const inv = shellInvocation("app", "/r", spec({ env: "e" }), ["just", "test"], "/ws", f.deps);
    expect(inv).toEqual({ cmd: ["just", "test"], cwd: "/ws", env: { FOO: "bar", PATH: "/x" } });
  });

  test("a prefix whose program is not on PATH runs the command as it is, with a warning", () => {
    const f = fake({}, undefined, (c) => c !== "nix");
    const inv = shellInvocation("app", "/r", spec({ enter: "nix develop --command" }), ["just", "test"], "/ws", f.deps);
    expect(inv).toEqual({ cmd: ["just", "test"], cwd: "/ws", env: {} });
    expect(f.state.warnings).toEqual(["nix not on PATH; running without app's dev shell"]);
  });

  test("an env command whose program is not on PATH is not captured", () => {
    const f = fake({}, undefined, (c) => c !== "nix");
    const inv = shellInvocation("app", "/r", spec({ enter: "nix develop --command", env: "nix develop --command env -0" }), ["just"], "/ws", f.deps);
    expect(inv).toEqual({ cmd: ["just"], cwd: "/ws", env: {} });
    expect(f.state.captures).toBe(0);
  });

  test("checks the env command's program when there is one, not enter's", () => {
    const f = fake({}, undefined, (c) => c !== "nix");
    const inv = shellInvocation("app", "/r", spec({ enter: "nix develop --command", env: "direnv exec . env -0" }), ["just"], "/ws", f.deps);
    expect(inv.env).toEqual({ FOO: "bar", PATH: "/x" });
    expect(f.state.warnings).toEqual([]);
  });
});

describe("leadingProgram", () => {
  test("is the first word", () => {
    expect(leadingProgram("  nix develop --command")).toBe("nix");
    expect(leadingProgram("/opt/bin/devbox run --")).toBe("/opt/bin/devbox");
  });

  test("skips leading assignments", () => {
    expect(leadingProgram("NIX_CONFIG=x FOO=1 nix develop")).toBe("nix");
  });

  test("is undefined for shell keywords, builtins and env, which are always there", () => {
    for (const c of ["if command -v nix; then nix develop; fi", ". ./activate &&", "env FOO=1", "exec direnv exec ."]) expect(leadingProgram(c)).toBeUndefined();
  });

  test("is undefined for an empty command", () => {
    expect(leadingProgram("   ")).toBeUndefined();
  });
});

describe("resolveEnv", () => {
  test("no env command means nothing to resolve", () => {
    const f = fake();
    expect(resolveEnv("app", "/r", spec(), f.deps)).toEqual({});
    expect(f.state.captures).toBe(0);
  });

  test("a repeat call with unchanged key files is served from the cache", () => {
    const f = fake({ "/r/flake.lock": "a" });
    const s = spec({ env: "e", key: ["flake.lock"] });
    expect(resolveEnv("app", "/r", s, f.deps)).toEqual({ FOO: "bar", PATH: "/x" });
    expect(resolveEnv("app", "/r", s, f.deps)).toEqual({ FOO: "bar", PATH: "/x" });
    expect(f.state.captures).toBe(1);

    f.store["/r/flake.lock"] = "b";
    resolveEnv("app", "/r", s, f.deps);
    expect(f.state.captures).toBe(2);
  });

  test("a failing env command is reported with its stderr", () => {
    const deps: ShellDeps = {
      ...fake().deps,
      capture: () => {
        throw new Error("shell.env `e` failed in /r:\nboom");
      },
    };
    expect(() => resolveEnv("app", "/r", spec({ env: "e" }), deps)).toThrow("boom");
  });
});

