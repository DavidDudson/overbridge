import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { run, spawnCwd } from "../src/util";

const start = process.cwd();
afterEach(() => process.chdir(start));

/** chdir into a fresh temp dir, then delete it, as `rm` does under a running sidebar pane. */
function strandInDeletedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ob-gone-"));
  process.chdir(dir);
  rmSync(dir, { recursive: true });
  return dir;
}

test("spawnCwd keeps an explicit cwd", () => {
  expect(spawnCwd("/somewhere")).toBe("/somewhere");
});

test("spawnCwd keeps the process cwd while it exists", () => {
  expect(spawnCwd()).toBe(process.cwd());
});

test("spawnCwd falls back to home once the process cwd is deleted", () => {
  strandInDeletedDir();
  expect(spawnCwd()).toBe(homedir());
});

test("run still spawns after the process cwd is deleted", () => {
  strandInDeletedDir();
  expect(run(["true"]).ok).toBe(true);
});
