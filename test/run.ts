import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELD_ENV } from "../src/check-queue";
import { ISOLATED_ENV } from "./helpers/isolation";

/** Variables a workspace, the check queue or a multiplexer sets that would point a test at real state. */
const INHERITED = ["OVERBRIDGE_NAME", "OVERBRIDGE_SELF", "OVERBRIDGE_SESSION", "OVERBRIDGE_TAB", "OVERBRIDGE_MUX", HELD_ENV, "WS_ROOT", "WS_NAME", "WS_SELF", "WS_SESSION", "TMUX", "TMUX_PANE"];

const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), `overbridge-${prefix}-`));

const root = tempDir("root");
const claudeConfig = tempDir("claude-config");
const agyConfig = tempDir("agy-config");

// Bun builds a child's environment from the one it started with and ignores later `process.env` edits,
// so the isolated values have to be in place before `bun test` starts for spawned CLIs to see them.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !INHERITED.includes(key))),
  OVERBRIDGE_ROOT: root,
  CLAUDE_CONFIG_DIR: claudeConfig,
  OVERBRIDGE_AGY_SETTINGS: join(agyConfig, "settings.json"),
  [ISOLATED_ENV]: "1",
};

try {
  const run = Bun.spawnSync({ cmd: [process.execPath, "test", ...Bun.argv.slice(2)], env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });

  process.exitCode = run.exitCode ?? 1;
} finally {
  [root, claudeConfig, agyConfig].forEach((dir) => rmSync(dir, { recursive: true, force: true }));
}
