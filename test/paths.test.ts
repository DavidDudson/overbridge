import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentWorkspace, envVar, metaDir, root } from "../src/paths";

const KEYS = ["OVERBRIDGE_ROOT", "WS_ROOT", "OVERBRIDGE_NAME", "WS_NAME"];
let saved: Record<string, string | undefined>;
let tmp: string;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  tmp = mkdtempSync(join(tmpdir(), "overbridge-paths-"));
});

afterEach(() => {
  for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  rmSync(tmp, { recursive: true, force: true });
});

describe("legacy env fallback", () => {
  test("OVERBRIDGE_* wins over WS_*", () => {
    process.env.OVERBRIDGE_ROOT = join(tmp, "new");
    process.env.WS_ROOT = join(tmp, "old");
    expect(root()).toBe(join(tmp, "new"));
  });

  test("WS_* is still read when OVERBRIDGE_* is unset", () => {
    process.env.WS_ROOT = tmp;
    process.env.WS_NAME = "ws7";
    expect(root()).toBe(tmp);
    expect(currentWorkspace("/nowhere")).toBe("ws7");
    expect(envVar("SESSION")).toBeUndefined();
  });
});

describe("state dir migration", () => {
  test("renames .ws to .overbridge once", () => {
    process.env.OVERBRIDGE_ROOT = tmp;
    mkdirSync(join(tmp, ".ws"));
    writeFileSync(join(tmp, ".ws", "state.json"), "{}");
    expect(metaDir()).toBe(join(tmp, ".overbridge"));
    expect(existsSync(join(tmp, ".ws"))).toBe(false);
    expect(existsSync(join(tmp, ".overbridge", "state.json"))).toBe(true);
    expect(metaDir()).toBe(join(tmp, ".overbridge"));
  });

  test("leaves an existing .overbridge alone", () => {
    process.env.OVERBRIDGE_ROOT = tmp;
    mkdirSync(join(tmp, ".ws"));
    mkdirSync(join(tmp, ".overbridge"));
    metaDir();
    expect(existsSync(join(tmp, ".ws"))).toBe(true);
  });
});
