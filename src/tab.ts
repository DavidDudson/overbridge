import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sidebarWidth } from "./config";
import { agentDirOf, newTabKdl } from "./layout";
import { metaDir, selfCommand, sessionName } from "./paths";
import { log, run } from "./util";

/** Runs a zellij command; tests pass a fake to see the calls without a session. */
export type ZellijExec = (cmd: string[]) => { ok: boolean; stdout: string; stderr?: string };

/** Where focus ends up after a tab opens: back on the tab you were on, or on the new tab. */
export const TabFocus = { Background: "background", Foreground: "foreground" } as const;
export type TabFocus = (typeof TabFocus)[keyof typeof TabFocus];

/** `run`, but a missing `zellij` binary reads as a failed call, the same as running outside a session. */
export const zellijQuery: ZellijExec = (cmd) => {
  try {
    return run(cmd);
  } catch {
    return { ok: false, stdout: "" };
  }
};

/**
 * `zellijQuery`, reaching the session by name when run outside it (a window-manager keybind has no `$ZELLIJ`):
 * `zellij action ...` becomes `zellij --session <name> action ...`. Inside zellij the calls pass through unchanged.
 */
export function sessionExec(inside = process.env.ZELLIJ !== undefined, session = sessionName(), exec: ZellijExec = zellijQuery): ZellijExec {
  if (inside) return exec;
  return (cmd) => exec(cmd[0] === "zellij" && cmd[1] === "action" ? ["zellij", "--session", session, ...cmd.slice(1)] : cmd);
}

/** Workspace names in zellij's tab order; empty outside zellij. */
export function tabOrder(exec: ZellijExec = zellijQuery): string[] {
  const r = exec(["zellij", "action", "query-tab-names"]);
  return r.ok ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

/** The workspace whose tab is focused; undefined outside zellij. */
export function currentTab(exec: ZellijExec = zellijQuery): string | undefined {
  const r = exec(["zellij", "action", "current-tab-info"]);
  return r.ok ? /^name: (.+)$/m.exec(r.stdout)?.[1]?.trim() : undefined;
}

/**
 * Open `ws` as a new tab of the running zellij session, its agent starting with `prompt`. In the background
 * (the default) focus returns to the tab you were on. Outside zellij there is no session to add to, so say how to get one.
 */
export function openTab(ws: string, prompt?: string, focus: TabFocus = TabFocus.Background, exec: ZellijExec = run, resume = false) {
  if (!process.env.ZELLIJ) {
    return log(`${ws} has no tab outside zellij; run \`overbridge up\` to open it`);
  }
  const dir = join(metaDir(), "tabs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${ws}.kdl`);
  writeFileSync(file, newTabKdl(ws, selfCommand(), { sidebarWidth: sidebarWidth(), focus: true, agentCwd: agentDirOf(ws), ...(prompt ? { prompt } : {}), ...(resume ? { resume } : {}) }));
  const back = focus === TabFocus.Background ? currentTab(exec) : undefined;
  const r = exec(["zellij", "action", "new-tab", "--layout", file, "--name", ws]);
  if (!r.ok) {
    return log(`could not open a tab for ${ws}: ${r.stderr || r.stdout}`);
  }
  // new-tab always focuses the tab it makes. The bare go-to-tab-name, not switchTab, returns focus to the pane you left.
  if (back !== undefined) {
    exec(["zellij", "action", "go-to-tab-name", back]);
  }
}
