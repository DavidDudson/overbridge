import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Workspace create and remove write Claude's trust list; keep every test off the real ~/.claude.json.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "overbridge-claude-config-"));

// Tests fake the multiplexer; one that runs inside tmux must not make `defaultMux` pick it.
for (const key of ["TMUX", "TMUX_PANE", "OVERBRIDGE_MUX"]) delete process.env[key];
