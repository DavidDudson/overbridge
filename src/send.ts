import { AgentKind } from "./agent-kind";
import { defaultMux, type Mux } from "./mux";
import { findPane } from "./panes";
import { agentOf, getWorkspace, isIceboxed, readState } from "./state";
import { fail } from "./util";

/**
 * `overbridge send <ws> <text>`: type `text` into workspace `ws`'s agent pane and submit it, as if the user had.
 * Only for agy, which has no `SendMessage`. The message waits behind a turn that is running, like anything typed there.
 */
export function send(ws: string, text: string, mux: Mux = defaultMux()): string {
  const w = getWorkspace(readState(), ws);
  // a control character (newline, carriage return, escape) would submit early or drive the TUI, so it becomes a space
  const flat = text.replace(/[\x00-\x1f\x7f]+/g, " ").trim();

  if (!flat) fail("usage: overbridge send <workspace> <text>: the message is empty");

  if (agentOf(w) !== AgentKind.Agy) fail(`${ws} runs ${agentOf(w)}; message it with SendMessage, not overbridge send`);

  // a leading ! runs a shell command in the agent's own TUI, outside every tool call the guard sees
  if (flat.startsWith("!")) fail("overbridge send refuses text starting with '!': it would run a shell command outside the guard");

  if (isIceboxed(w)) fail(`${ws} is iceboxed, so no agent is running; thaw it first with \`overbridge thaw ${ws}\``);
  const pane = findPane(mux.listPanes(), ws, "claude");

  if (!pane) fail(`${ws} has no running agent pane in this ${mux.kind} session; open its tab with \`overbridge tab ${ws}\``);

  if (!mux.sendText(pane.id, flat)) fail(`could not type into ${ws}'s agy pane (${pane.id}); ${mux.kind} refused the input`);

  return `sent to ${ws} (${agentOf(w)})`;
}
