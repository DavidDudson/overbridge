import { defaultMux, type Mux } from "./mux";
import { findPane } from "./panes";
import { agentOf, getWorkspace, isIceboxed, readState } from "./state";
import { fail } from "./util";

/**
 * `overbridge send <ws> <text>`: type `text` into workspace `ws`'s agent pane and submit it, as if the user had.
 * It reaches an agent that has no `SendMessage` (agy), and works for Claude too. The message waits behind a
 * turn that is running, like anything typed there.
 */
export function send(ws: string, text: string, mux: Mux = defaultMux()): string {
  const w = getWorkspace(readState(), ws);

  if (!text.trim()) fail("usage: overbridge send <workspace> <text>: the message is empty");

  if (isIceboxed(w)) fail(`${ws} is iceboxed, so no agent is running; thaw it first with \`overbridge thaw ${ws}\``);
  const pane = findPane(mux.listPanes(), ws, "claude");

  if (!pane) fail(`${ws} has no running agent pane in this ${mux.kind} session; open its tab with \`overbridge tab ${ws}\``);

  if (!mux.sendText(pane.id, text)) fail(`could not type into ${ws}'s ${agentOf(w)} pane (${pane.id}); ${mux.kind} refused the input`);

  return `sent to ${ws} (${agentOf(w)})`;
}
