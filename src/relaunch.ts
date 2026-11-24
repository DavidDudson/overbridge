import { rmSync } from "node:fs";
import { type AgentLaunch, DEFAULT_MODEL, EMPTY_LAUNCH, isEmptyLaunch, modelFault, onlyModelChanged, onlyShorthands, usesClaudeOnly, withModel } from "./agent-launch";
import { AgentKind } from "./agent-kind";
import { AT_REST, type AgentState, readAgentState } from "./agent-state";
import { ancestry, type Launcher, readLauncher, RELAUNCH_SIGNAL, relaunchRequestPath, SessionMode, workspaceAbove, writeRelaunchRequest } from "./agent-supervisor";
import { HandoffReason, handoffRows, thawFirstMessage, writeHandoff } from "./handoff";
import { defaultMux, type Mux } from "./mux";
import { isOrchestrationTab } from "./orchestration";
import { pidAlive, readProc } from "./proc";
import { leaveTab } from "./remove";
import { agentOf, getWorkspace, isIceboxed, isRemoving, readState, withState } from "./state";
import { requireTab, TabFocus } from "./tab";
import { errorMessage, fail, log } from "./util";

/** What a relaunch changes, which decides what an agent may pass: any launch built from the shorthands, or only a new model. */
export const LaunchChange = { Settings: "settings", Model: "model" } as const;

export type LaunchChange = (typeof LaunchChange)[keyof typeof LaunchChange];

export interface RelaunchOptions {
  /** Replaces the workspace's launch settings; empty goes back to the root config's `agent-launch`. */
  launch: AgentLaunch;
  /** Unset means `LaunchChange.Settings`. */
  change?: LaunchChange | undefined;
  /** The handoff's Next line; unset says `overbridge relaunch` restarted the agent. */
  next?: string | undefined;
  /** Carried out after the handoff, in place of its Next line. */
  prompt?: string | undefined;
  session: SessionMode;
  /** Stop an agent that is mid-turn. */
  force?: boolean | undefined;
}

/** Who runs `relaunch`: the workspace whose tab it runs in, if any, whether an agent runs it, and whether stdin is a terminal. */
export interface Caller {
  ws?: string | undefined;
  agent: boolean;
  /** An agent's shell has no terminal, and unsetting env vars cannot give it one. */
  interactive: boolean;
}

export interface RelaunchDeps {
  mux: Mux;
  /** The live supervisor of `ws`'s agent, if any. */
  launcher: (ws: string) => Launcher | undefined;
  caller: () => Caller;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  agentState: (ws: string) => AgentState | undefined;
  /** Open `ws`'s tab with its agent starting on `prompt`. */
  open: (ws: string, prompt: string, session: SessionMode) => void;
}

function liveLauncher(ws: string): Launcher | undefined {
  const l = readLauncher(ws);

  return l && pidAlive(l.pid) && pidAlive(l.child) ? l : undefined;
}

/**
 * The caller's workspace comes from the supervisor above it in the process tree, else `OVERBRIDGE_NAME`; it is an
 * agent when it runs under a supervisor or Claude Code marks its tools' environment (`CLAUDECODE`).
 */
export function currentCaller(env: Record<string, string | undefined> = process.env): Caller {
  const launchers = Object.fromEntries(
    Object.keys(readState().workspaces).flatMap((ws): [string, Launcher][] => {
      const l = liveLauncher(ws);

      return l ? [[ws, l]] : [];
    }),
  );

  const above = workspaceAbove(ancestry(process.pid, (pid) => readProc(pid)?.ppid), launchers);

  return { ws: above ?? (env.OVERBRIDGE_NAME || undefined), agent: above !== undefined || env.CLAUDECODE === "1", interactive: process.stdin.isTTY === true };
}

export const relaunchDeps = (mux: Mux = defaultMux()): RelaunchDeps => ({
  mux,
  launcher: liveLauncher,
  caller: () => currentCaller(),
  signal: (pid, signal) => process.kill(pid, signal),
  agentState: (ws) => readAgentState(ws),
  open: (ws, prompt, session) => requireTab(ws, prompt, TabFocus.Foreground, mux, session === SessionMode.Continue),
});

/**
 * Refuse a relaunch that must not happen, before anything is written. An agent may relaunch only its own workspace
 * (the orchestrator, in no workspace, any), and may set only the `--no-code-mode`/`--chrome` settings, or through
 * `overbridge model` only a new model, so it cannot start itself with arguments or env that loosen its permissions.
 */
/** What `assertRelaunchable` learned: whether the caller runs in `ws`'s own tab, and `ws`'s live supervisor. */
interface Relaunchable {
  inOwnTab: boolean;
  launcher: Launcher | undefined;
}

function assertRelaunchable(ws: string, opts: RelaunchOptions, deps: RelaunchDeps): Relaunchable {
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

  const caller = deps.caller();

  if (caller.agent && caller.ws !== undefined && caller.ws !== ws) {
    fail(`an agent can relaunch only its own workspace (${caller.ws}), not ${ws}`);
  }

  const agentMay = opts.change === LaunchChange.Model ? onlyModelChanged(opts.launch, w.launch ?? EMPTY_LAUNCH) : onlyShorthands(opts.launch);

  if (!agentMay && (caller.agent || !caller.interactive)) {
    fail("--env and agent arguments are for the user: run overbridge relaunch yourself, in a terminal; an agent can set only --no-code-mode, --chrome and the model (overbridge model)");
  }

  const inOwnTab = caller.ws === ws;
  const launcher = deps.launcher(ws);

  if (inOwnTab && !launcher) {
    fail(`${ws}'s agent has no supervisor (an older overbridge started it), so a relaunch would close the tab it runs in; run \`overbridge relaunch ${ws}\` from another tab`);
  }

  const state = deps.agentState(ws);

  if (!(inOwnTab && caller.agent) && !opts.force && !AT_REST.has(state)) {
    fail(`${ws}'s agent is ${state}; wait for it to finish, or pass --force to stop it now`);
  }

  return { inOwnTab, launcher };
}

/** Ask the supervisor to restart the agent; false when it is gone, so the caller falls back to reopening the tab. */
function signalSupervisor(ws: string, launcher: Launcher, prompt: string, opts: RelaunchOptions, deps: RelaunchDeps): boolean {
  writeRelaunchRequest(ws, { session: opts.session, prompt, requestedAtMs: Date.now() });

  try {
    deps.signal(launcher.pid, RELAUNCH_SIGNAL);

    return true;
  } catch (e) {
    rmSync(relaunchRequestPath(ws), { force: true });
    log(`${ws}'s supervisor (pid ${launcher.pid}) did not take the relaunch: ${errorMessage(e)}; reopening the tab`);

    return false;
  }
}

/** Write a handoff, store `opts.launch`, and restart `ws`'s agent on `/read-handoff`; returns the handoff path. */
export function relaunch(ws: string, opts: RelaunchOptions, deps: RelaunchDeps = relaunchDeps()): string {
  const { inOwnTab, launcher } = assertRelaunchable(ws, opts, deps);

  const handoff = writeHandoff({
    ws,
    reason: HandoffReason.Relaunch,
    next: opts.next ?? `\`overbridge relaunch ${ws}\` restarted the agent; carry on with the task in progress`,
    rows: handoffRows(ws),
  });

  withState((s) => {
    const { launch: _, ...rest } = getWorkspace(s, ws);
    s.workspaces[ws] = isEmptyLaunch(opts.launch) ? rest : { ...rest, launch: opts.launch };
  });
  const prompt = thawFirstMessage(opts.prompt);

  if (launcher && signalSupervisor(ws, launcher, prompt, opts, deps)) {
    return handoff;
  }

  if (inOwnTab) {
    fail(`${ws}'s supervisor is gone, and reopening the tab would close the one this runs in; run \`overbridge relaunch ${ws}\` from another tab`);
  }

  if (deps.mux.inSession() && deps.mux.tabs().includes(ws)) {
    leaveTab(ws, undefined, deps.mux);
  }

  deps.open(ws, prompt, opts.session);

  return handoff;
}

/** How `switchModel` restarts the agent: same conversation or a new one, and whether to stop one mid-turn. */
export interface SwitchModelOptions {
  session: SessionMode;
  force?: boolean | undefined;
}

/**
 * Restart `ws`'s agent on `model` (`DEFAULT_MODEL` drops the workspace's model), keeping its other launch settings,
 * so the model sticks for `up`, `tab` and `thaw`; returns the handoff path.
 */
export function switchModel(ws: string, model: string, opts: SwitchModelOptions, deps: RelaunchDeps = relaunchDeps()): string {
  const chosen = model === DEFAULT_MODEL ? undefined : model;
  const fault = chosen === undefined ? undefined : modelFault(chosen);

  if (fault !== undefined) {
    fail(`model '${model}': ${fault}`);
  }

  const current = getWorkspace(readState(), ws).launch ?? EMPTY_LAUNCH;
  const next = `\`overbridge model ${ws} ${model}\` restarted the agent on ${chosen ?? "its default model"}; carry on with the task in progress`;

  return relaunch(ws, { launch: withModel(current, chosen), change: LaunchChange.Model, next, session: opts.session, force: opts.force }, deps);
}
