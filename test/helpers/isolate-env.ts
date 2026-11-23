import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Workspace create and remove write Claude's and agy's trust lists; keep every test off ~/.claude.json and ~/.gemini.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "overbridge-claude-config-"));

process.env.OVERBRIDGE_AGY_SETTINGS = join(mkdtempSync(join(tmpdir(), "overbridge-agy-config-")), "settings.json");

// A test run inside a workspace inherits its root and name; give every test a throwaway root instead.
process.env.OVERBRIDGE_ROOT = mkdtempSync(join(tmpdir(), "overbridge-root-"));

for (const key of ["OVERBRIDGE_NAME", "OVERBRIDGE_SELF", "OVERBRIDGE_SESSION", "OVERBRIDGE_TAB", "WS_ROOT", "WS_NAME", "WS_SELF", "WS_SESSION"]) delete process.env[key];

// Tests fake the multiplexer; one that runs inside tmux must not make `defaultMux` pick it.
for (const key of ["TMUX", "TMUX_PANE", "OVERBRIDGE_MUX"]) delete process.env[key];
