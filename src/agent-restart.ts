import { restartAfter, STOP_SIGNALS } from "./orchestration-keep";

/** What the supervisor does when its agent exits with no relaunch request: stop, or start again after `delayMs`. */
export type AfterExit = { restart: false } | { restart: true; streak: number; delayMs: number; args: string[] };

export interface ExitFacts {
  elapsedMs: number;
  /** Quick exits in a row before this one. */
  streak: number;
  /** The user ended the session on purpose (`/exit`): the workspace is going away, so it stays closed. */
  endedForGood: boolean;
  /** The signal that ended the agent, if any. A stop signal means the tab or workspace is going away. */
  signal?: string | null;
}

/** An agent that exits on its own resumes (`--continue`), backing off when it keeps exiting quickly; `--continue` fails with nothing to resume, so a second quick exit starts fresh. */
export function afterAgentExit(f: ExitFacts): AfterExit {
  if (f.endedForGood || (f.signal != null && STOP_SIGNALS.has(f.signal))) return { restart: false };
  const next = restartAfter(f.elapsedMs, f.streak);

  return { restart: true, ...next, args: next.streak <= 1 ? ["--continue"] : [] };
}

/** `args` without the resume flag: only the ones before the `--` that starts the prompt are flags. */
export function withoutContinue(args: readonly string[]): string[] {
  const split = args.indexOf("--");
  const flags = split === -1 ? args : args.slice(0, split);

  return [...flags.filter((a) => a !== "--continue"), ...(split === -1 ? [] : args.slice(split))];
}

/**
 * The argv for the next agent start. `--continue` fails at once when there is no conversation, so without one
 * (`canResume` false) it is dropped and the agent starts fresh. A restart after a failed first launch then repeats
 * that launch's own arguments (its prompt) rather than resuming nothing.
 */
export function launchArgs(args: readonly string[], canResume: boolean, firstArgs: readonly string[]): string[] {
  if (canResume || !args.includes("--continue")) return [...args];

  return withoutContinue(args.every((a) => a === "--continue") ? firstArgs : args);
}
