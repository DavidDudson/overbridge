import { ensureAgentPane, resetAgentKeep } from "./agent-keep";
import { type Launcher, readLauncher } from "./agent-supervisor";
import { defaultMux, type Mux } from "./mux";
import { pidAlive } from "./proc";
import { fail, log } from "./util";

/** How long a new agent has to come up (a burst of starts under load is slow, not broken), and how long it must stay up to count as started. */
export const AGENT_UP_MS = 60_000;
export const AGENT_STABLE_MS = 2_000;
const POLL_MS = 500;

/** Set (the test runner does) to skip the wait for a real agent, which a fake multiplexer never starts. */
export const SKIP_VERIFY_ENV = "OVERBRIDGE_NO_AGENT_CHECK";

export interface VerifyDeps {
  /** The live supervisor of `ws`'s agent, when its process and the agent's are both running. */
  launcher: (ws: string) => Launcher | undefined;
  now: () => number;
  sleep: (ms: number) => void;
  /** Open Claude's pane again; false when it could not be. */
  reopen: (ws: string, prompt?: string) => boolean;
  /** How many times to reopen a pane that never came up before giving up. */
  retries: number;
}

export const liveLauncher = (ws: string): Launcher | undefined => {
  const l = readLauncher(ws);

  return l && pidAlive(l.pid) && pidAlive(l.child) ? l : undefined;
};

/** Wait until `ws`'s agent has been running for `AGENT_STABLE_MS` without a break; false when `AGENT_UP_MS` passes first. */
export function agentCameUp(ws: string, deps: Pick<VerifyDeps, "launcher" | "now" | "sleep">): boolean {
  const deadline = deps.now() + AGENT_UP_MS;
  let upSince: number | undefined;

  while (deps.now() < deadline) {
    const now = deps.now();
    const l = deps.launcher(ws);

    upSince = l ? (upSince ?? now) : undefined;

    if (upSince !== undefined && now - upSince >= AGENT_STABLE_MS) return true;
    deps.sleep(POLL_MS);
  }

  return false;
}

export const verifyDeps = (mux: Mux = defaultMux()): VerifyDeps => ({
  launcher: liveLauncher,
  now: Date.now,
  sleep: (ms) => Bun.sleepSync(ms),
  reopen: (ws, prompt) => {
    // the pane just failed, so the cooldown that spaces the sidebar's reopens does not apply
    resetAgentKeep();

    return ensureAgentPane(ws, { mux }, prompt);
  },
  retries: 2,
});

/**
 * After a tab opened (or a pane restarted), make sure the agent really runs: its supervisor registered and its
 * process stayed up. When it did not, open Claude's pane again up to `retries` times, then fail loudly, since a tab
 * with only the top bar looks like a working workspace. A reopened pane starts on `prompt`, which the pane that
 * never came up lost. Does nothing outside a multiplexer session.
 */
export function requireAgent(ws: string, mux: Mux = defaultMux(), deps?: VerifyDeps, prompt?: string): void {
  if (!mux.inSession() || (!deps && process.env[SKIP_VERIFY_ENV])) return;
  const check = deps ?? verifyDeps(mux);

  for (let attempt = 0; ; attempt++) {
    if (agentCameUp(ws, check)) return;

    if (attempt >= check.retries) break;
    log(`${ws}'s agent did not come up; opening its pane again (${attempt + 1}/${check.retries})`);

    if (!check.reopen(ws, prompt)) log(`${ws}: could not reopen the agent pane`);
  }

  fail(`${ws}'s agent did not start. Its tab is open with no agent; run \`overbridge relaunch ${ws} --fresh --force\`, or open the pane's log with \`overbridge tab ${ws}\``);
}
