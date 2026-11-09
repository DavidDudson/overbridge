import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { externalCommand, externalCommands, externalHelp } from "../src/external";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
let tmp: string;
let first: string;
let second: string;

function script(dir: string, name: string, body: string, mode = 0o755) {
  const file = join(dir, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, mode);
  return file;
}

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-external-")));
  first = join(tmp, "first");
  second = join(tmp, "second");
  mkdirSync(first);
  mkdirSync(second);
  script(first, "overbridge-hello", 'echo "args=$*"; echo "root=$OVERBRIDGE_ROOT"; echo "name=$OVERBRIDGE_NAME"; exit 3');
  script(second, "overbridge-hello", "echo shadowed");
  script(second, "overbridge-zzz", "true");
  script(second, "overbridge-off", "true", 0o644);
  script(second, "overbridge-Bad", "true");
  script(second, "unrelated", "true");
  mkdirSync(join(second, "overbridge-dir"));
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PATH = () => [first, second, join(tmp, "missing")].join(delimiter);

describe("externalCommand", () => {
  test("finds the first executable overbridge-<name> on PATH", () => {
    expect(externalCommand("hello", PATH())).toBe(join(first, "overbridge-hello"));
    expect(externalCommand("zzz", PATH())).toBe(join(second, "overbridge-zzz"));
  });

  test("ignores files that are not executable, directories and bad names", () => {
    expect(externalCommand("off", PATH())).toBeUndefined();
    expect(externalCommand("dir", PATH())).toBeUndefined();
    expect(externalCommand("Bad", PATH())).toBeUndefined();
    expect(externalCommand("../first/overbridge-hello", PATH())).toBeUndefined();
    expect(externalCommand("nope", PATH())).toBeUndefined();
    expect(externalCommand("hello", "")).toBeUndefined();
  });
});

describe("externalCommands", () => {
  test("lists each name once, sorted", () => {
    expect(externalCommands(PATH())).toEqual(["hello", "zzz"]);
    expect(externalHelp(PATH())).toContain("  overbridge hello\n  overbridge zzz");
    expect(externalHelp("")).toBe("");
  });
});

describe("overbridge <external>", () => {
  const run = (args: string[], env: Record<string, string> = {}) => {
    const p = Bun.spawnSync({
      cmd: [process.execPath, CLI, ...args],
      cwd: tmp,
      env: { ...process.env, PATH: `${PATH()}${delimiter}${process.env.PATH}`, OVERBRIDGE_ROOT: tmp, OVERBRIDGE_NAME: "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };

  test("runs it with the args, the root and the bound workspace, and passes its exit code on", () => {
    const r = run(["hello", "a", "b c"], { OVERBRIDGE_NAME: "ws1" });
    expect(r.code).toBe(3);
    expect(r.out).toBe(`args=a b c\nroot=${tmp}\nname=ws1\n`);
  });

  test("a built-in name never runs an external command", () => {
    script(first, "overbridge-whoami", "echo external");
    expect(run(["whoami"]).out).not.toContain("external");
  });

  test("an unknown name still fails, and help lists the external commands", () => {
    const r = run(["nope"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown command 'nope'");
    expect(run(["help"]).out).toContain("External (overbridge-<name> on PATH)\n  overbridge hello");
  });
});
