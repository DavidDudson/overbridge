import { restartAfter } from "./orchestration-keep";

/** What the supervisor does when its agent exits with no relaunch request: stop, or start again after `delayMs`. */
export type AfterExit = { restart: false } | { restart: true; streak: number; delayMs: number; args: string[] };

export interface ExitFacts {
  /** How long the agent ran. */
  elapsedMs: number;
  /** Quick exits in a row before this one. */
  streak: number;
  /** The user ended the session on purpose (`/exit`): the workspace is going away, so it stays closed. */
  endedForGood: boolean;
  /** The signal that ended the agent, if any. A hang-up means the terminal is gone, so there is nothing to restart into. */
  signal?: string | null;
}

/**
 * An agent that exits on its own is started again, resuming its last conversation (`--continue`). One that keeps
 * exiting quickly backs off (`restartAfter`: 1s, 2s, 4s, up to 30s), and once the resumed one has exited quickly too the next
 * start is a fresh conversation, since `--continue` fails when there is nothing to resume.
 */
export function afterAgentExit(f: ExitFacts): AfterExit {
  if (f.endedForGood || f.signal === "SIGHUP") return { restart: false };
  const next = restartAfter(f.elapsedMs, f.streak);

  return { restart: true, ...next, args: next.streak <= 1 ? ["--continue"] : [] };
}
