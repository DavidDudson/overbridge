import { type AgentLaunch, ancestry, isEmptyLaunch, type Launcher, readLauncher, RELAUNCH_SIGNAL, SessionMode, usesClaudeOnly, workspaceAbove, writeRelaunchRequest } from "./agent-launch";
import { AgentKind } from "./agent-kind";
import { AT_REST, type AgentState, readAgentState } from "./agent-state";
import { HandoffReason, writeHandoff } from "./handoff";
import { handoffRows, thawFirstMessage } from "./icebox";
import { defaultMux, type Mux } from "./mux";
import { isOrchestrationTab } from "./orchestration";
import { pidAlive, readProc } from "./proc";
import { leaveTab } from "./remove";
import { agentOf, getWorkspace, isIceboxed, isRemoving, readState, withState } from "./state";
import { requireTab, TabFocus } from "./tab";
import { fail } from "./util";

export interface RelaunchOptions {
  /** Replaces the workspace's launch settings; empty goes back to the root config's `agent-launch`. */
  launch: AgentLaunch;
  /** Carried out after the handoff, in place of its Next line. */
  prompt?: string | undefined;
  session: SessionMode;
  /** Stop an agent that is mid-turn. */
  force?: boolean | undefined;
}

export interface RelaunchDeps {
  mux: Mux;
  /** The live supervisor of `ws`'s agent, if any. */
  launcher: (ws: string) => Launcher | undefined;
  /** The workspace whose agent this process runs under, if any. */
  callerWorkspace: () => string | undefined;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  agentState: (ws: string) => AgentState | undefined;
  /** Open `ws`'s tab with its agent starting on `prompt`. */
  open: (ws: string, prompt: string, session: SessionMode) => void;
}

function liveLauncher(ws: string): Launcher | undefined {
  const l = readLauncher(ws);

  return l && pidAlive(l.pid) && pidAlive(l.child) ? l : undefined;
}

function callerWorkspace(): string | undefined {
  const launchers = Object.fromEntries(Object.keys(readState().workspaces).flatMap((ws) => {
    const l = liveLauncher(ws);

    return l ? [[ws, l]] : [];
  }));

  return workspaceAbove(ancestry(process.pid, (pid) => readProc(pid)?.ppid), launchers);
}

export const relaunchDeps = (mux: Mux = defaultMux()): RelaunchDeps => ({
  mux,
  launcher: liveLauncher,
  callerWorkspace,
  signal: (pid, signal) => process.kill(pid, signal),
  agentState: (ws) => readAgentState(ws),
  open: (ws, prompt, session) => requireTab(ws, prompt, TabFocus.Foreground, mux, session === SessionMode.Continue),
});

/**
 * Write a handoff, store `opts.launch` for the workspace, and restart its agent on `/read-handoff`. A running
 * supervisor (`overbridge claude`) restarts it in place; otherwise the tab is closed, when there is one, and opened again.
 * A workspace's own agent can relaunch only that workspace. Returns the handoff path.
 */
export function relaunch(ws: string, opts: RelaunchOptions, deps: RelaunchDeps = relaunchDeps()): string {
  if (isOrchestrationTab(ws)) {
    fail(`${ws} is an orchestration tab; it restarts its own Claude when Claude exits`);
  }

  const w = getWorkspace(readState(), ws);

  if (isRemoving(w)) {
    fail(`${ws} is being removed`);
  }

  if (isIceboxed(w)) {
    fail(`${ws} is iceboxed; \`overbridge thaw ${ws}\` starts its agent`);
  }

  if (agentOf(w) !== AgentKind.Claude && usesClaudeOnly(opts.launch)) {
    fail(`${ws} runs ${agentOf(w)}; --no-code-mode and --chrome are Claude Code settings`);
  }

  const caller = deps.callerWorkspace();

  if (caller !== undefined && caller !== ws) {
    fail(`an agent can relaunch only its own workspace (${caller}), not ${ws}`);
  }

  const self = caller === ws;
  const launcher = deps.launcher(ws);

  if (self && !launcher) {
    fail(`${ws}'s agent was started by an older overbridge that cannot restart it in place; ask the user to run \`overbridge relaunch ${ws}\``);
  }

  const state = deps.agentState(ws);

  if (!self && !opts.force && !AT_REST.has(state)) {
    fail(`${ws}'s agent is ${state}; wait for it to finish, or pass --force to stop it now`);
  }

  const handoff = writeHandoff({
    ws,
    reason: HandoffReason.Relaunch,
    next: `\`overbridge relaunch ${ws}\` restarted the agent; carry on with the task in progress`,
    rows: handoffRows(ws),
  });

  withState((s) => {
    const { launch: _, ...rest } = getWorkspace(s, ws);
    s.workspaces[ws] = isEmptyLaunch(opts.launch) ? rest : { ...rest, launch: opts.launch };
  });
  const prompt = thawFirstMessage(opts.prompt);

  if (launcher) {
    writeRelaunchRequest(ws, { session: opts.session, prompt, at: Date.now() });
    deps.signal(launcher.pid, RELAUNCH_SIGNAL);

    return handoff;
  }

  if (deps.mux.inSession() && deps.mux.tabs().includes(ws)) {
    leaveTab(ws, undefined, deps.mux);
  }

  deps.open(ws, prompt, opts.session);

  return handoff;
}
