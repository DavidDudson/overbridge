import { expect, test } from "bun:test";
import { tmpdir } from "node:os";

test("a CLI a test spawns without an env inherits the isolated root, not the workspace's", () => {
  const child = Bun.spawnSync({ cmd: ["sh", "-c", 'printf "%s|%s|%s|%s" "$OVERBRIDGE_ROOT" "$OVERBRIDGE_NAME" "$OVERBRIDGE_SELF" "$CLAUDE_CONFIG_DIR"'], stdout: "pipe" });
  const [root, name, self, claudeConfig] = child.stdout.toString().split("|");

  expect(root).toBe(process.env.OVERBRIDGE_ROOT!);
  expect(root!.startsWith(tmpdir())).toBe(true);
  expect(name).toBe("");
  expect(self).toBe("");
  expect(claudeConfig).toBe(process.env.CLAUDE_CONFIG_DIR!);
});
