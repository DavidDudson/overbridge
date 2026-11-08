import { readdirSync, readFileSync } from "node:fs";

/**
 * Background shells of a Claude session, found from /proc. Imported by the agent hook, so
 * it uses node builtins only. Linux only: elsewhere it finds nothing.
 */

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "fish", "nu"]);

interface Proc {
  pid: number;
  ppid: number;
  comm: string;
}

function readProc(pid: number): Proc | undefined {
  try {
    // "<pid> (<comm>) <state> <ppid> ..."; comm may contain spaces and parens
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const open = stat.indexOf("(");
    const close = stat.lastIndexOf(")");
    const rest = stat.slice(close + 2).split(" ");
    return { pid, ppid: Number(rest[1]), comm: stat.slice(open + 1, close) };
  } catch {
    return undefined;
  }
}

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
    return readdirSync("/proc")
      .filter((d) => /^\d+$/.test(d))
      .map((d) => readProc(Number(d)))
      .filter((p): p is Proc => !!p && p.ppid === rootPid && SHELLS.has(p.comm) && !ancestors.has(p.pid))
      .map((p) => p.pid);
  } catch {
    return [];
  }
}
