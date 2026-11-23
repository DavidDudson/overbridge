import { describe, expect, test } from "bun:test";
import { chainedCommands, chainRefusal, localBin, shellScript, withLocalBin } from "../src/check-command";

describe("shellScript", () => {
  test("the script of sh -c, bash -lc and a full path", () => {
    expect(shellScript(["sh", "-c", "just test"])).toBe("just test");
    expect(shellScript(["bash", "-lc", "just test"])).toBe("just test");
    expect(shellScript(["/bin/bash", "-e", "-c", "just test"])).toBe("just test");
  });

  test("nothing for a plain command or a script file", () => {
    expect(shellScript(["just", "test"])).toBeUndefined();
    expect(shellScript(["bash", "ci.sh"])).toBeUndefined();
  });
});

describe("chainedCommands", () => {
  test("splits on ; && || & and newlines", () => {
    expect(chainedCommands("just lint; just test")).toEqual(["just lint", "just test"]);
    expect(chainedCommands("cd a && vitest run || echo failed")).toEqual(["cd a", "vitest run", "echo failed"]);
    expect(chainedCommands("tsc --noEmit\nbun test")).toEqual(["tsc --noEmit", "bun test"]);
    expect(chainedCommands("server & bun test")).toEqual(["server", "bun test"]);
  });

  test("a pipeline and redirects are one command", () => {
    expect(chainedCommands("vitest run 2>&1 | rg 'x;y' | tail -5")).toEqual(["vitest run 2>&1 | rg 'x;y' | tail -5"]);
    expect(chainedCommands("tsc &> out.log")).toEqual(["tsc &> out.log"]);
  });

  test("quotes and escapes hide separators", () => {
    expect(chainedCommands(`rg "a && b" src`)).toEqual([`rg "a && b" src`]);
    expect(chainedCommands("echo a\\; b")).toEqual(["echo a\\; b"]);
  });

  test("set lines run nothing, so they do not count", () => {
    expect(chainedCommands("set -o pipefail; nx affected -t test | tail")).toEqual(["nx affected -t test | tail"]);
  });
});

describe("chainRefusal", () => {
  test("refuses a chained script and shows how to split it", () => {
    const message = chainRefusal(["bash", "-c", "just lint && just test"], "app") ?? "";
    expect(message).toContain("chains 2: `just lint`, `just test`");
    expect(message).toContain("overbridge check app -- ");
  });

  test("allows one command, with or without a shell around it", () => {
    expect(chainRefusal(["bash", "-c", "vitest run x | tail -5"], "app")).toBeUndefined();
    expect(chainRefusal(["pnpm", "nx", "affected", "-t", "lint;test"], "app")).toBeUndefined();
  });
});

describe("localBin", () => {
  const root = "/ws/app";
  const has = (...paths: string[]) => (p: string) => paths.includes(p);

  test("the nearest node_modules/.bin from the cwd up to the repo", () => {
    const exists = has("/ws/app/node_modules/.bin/nx", "/ws/app/libs/ui/node_modules/.bin/vitest");
    expect(localBin("vitest", "/ws/app/libs/ui/src", root, exists)).toBe("/ws/app/libs/ui/node_modules/.bin/vitest");
    expect(localBin("nx", "/ws/app/libs/ui", root, exists)).toBe("/ws/app/node_modules/.bin/nx");
  });

  test("never above the repo", () => {
    expect(localBin("nx", "/ws/app", root, has("/ws/node_modules/.bin/nx"))).toBeUndefined();
  });

  test("withLocalBin swaps only a bare program it finds", () => {
    const exists = has("/ws/app/node_modules/.bin/nx");
    expect(withLocalBin(["nx", "affected", "-t", "lint"], root, root, exists)).toEqual(["/ws/app/node_modules/.bin/nx", "affected", "-t", "lint"]);
    expect(withLocalBin(["just", "test"], root, root, exists)).toEqual(["just", "test"]);
    expect(withLocalBin(["./nx", "build"], root, root, exists)).toEqual(["./nx", "build"]);
  });
});
