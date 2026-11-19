import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Workspace create and remove write Claude's and agy's trust lists; keep every test off ~/.claude.json and ~/.gemini.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "overbridge-claude-config-"));

process.env.OVERBRIDGE_AGY_SETTINGS = join(mkdtempSync(join(tmpdir(), "overbridge-agy-config-")), "settings.json");

// Tests fake the multiplexer; one that runs inside tmux must not make `defaultMux` pick it.
for (const key of ["TMUX", "TMUX_PANE", "OVERBRIDGE_MUX"]) delete process.env[key];
