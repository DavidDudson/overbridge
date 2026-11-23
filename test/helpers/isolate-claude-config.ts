import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Workspace create and remove write Claude's and agy's trust lists; keep every test off ~/.claude.json and ~/.gemini.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "overbridge-claude-config-"));

process.env.OVERBRIDGE_AGY_SETTINGS = join(mkdtempSync(join(tmpdir(), "overbridge-agy-config-")), "settings.json");

// Tests fake the multiplexer. A suite run inside tmux or zellij (`overbridge check` runs in a pane) must not reach
// the live session: `defaultMux` picks the session it runs in, else `sessionName()`, which is the live one by default.
for (const key of ["TMUX", "TMUX_PANE", "OVERBRIDGE_MUX", "ZELLIJ", "ZELLIJ_SESSION_NAME", "ZELLIJ_PANE_ID", "WS_SESSION"]) delete process.env[key];

process.env.OVERBRIDGE_SESSION = `overbridge-test-${process.pid}`;
