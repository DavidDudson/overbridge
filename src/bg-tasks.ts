import { listProcs, type Proc, readProc } from "./proc";

/**
 * Background shells of a Claude session, found from the process table (`/proc` on Linux, `ps` on macOS).
 * Imported by the agent hook, so it uses node builtins only.
 */

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "fish", "nu"]);

/** macOS prints login shells as `-zsh`. */
const shellName = (comm: string) => comm.replace(/^-/, "");

/** The process in `from`'s ancestry named `claude`, else its parent. */
function sessionRoot(from: number): number | undefined {
  let pid = from;
  const first = readProc(pid)?.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    const p = readProc(pid);
    if (!p) break;
    if (/claude/.test(p.comm)) return p.pid;
    pid = p.ppid;
  }
  return first;
}

/**
 * Pids of shells still running under the Claude session `from` belongs to, apart from `from`'s
 * own ancestors (the hook's shell). Between turns these are background tasks.
 */
export function backgroundShells(from = process.pid): number[] {
  try {
    const rootPid = sessionRoot(from);
    if (rootPid === undefined) return [];
    const ancestors = new Set<number>();
    for (let p = from; p > 1 && !ancestors.has(p); p = readProc(p)?.ppid ?? 0) ancestors.add(p);
    return listProcs()
      .filter((p: Proc) => p.ppid === rootPid && SHELLS.has(shellName(p.comm)) && !ancestors.has(p.pid))
      .map((p) => p.pid);
  } catch {
    return [];
  }
}
