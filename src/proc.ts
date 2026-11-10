import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";

/**
 * Process lookups that work on Linux (`/proc`) and macOS (`ps`). Imported by the agent hook, so
 * it uses node builtins only.
 */

export interface Proc {
  pid: number;
  ppid: number;
  /** The executable's name, without a path. */
  comm: string;
  /** The state letters, e.g. `S`, `R+`, `Z`. */
  state: string;
}

/** `/proc/<pid>/stat`: `<pid> (<comm>) <state> <ppid> ...`; comm may contain spaces and parens, so cut at the last `)`. */
export function parseStat(pid: number, stat: string): Proc | undefined {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const rest = stat.slice(close + 2).split(" ");
  const ppid = Number(rest[1]);
  if (!rest[0] || Number.isNaN(ppid)) return undefined;
  return { pid, ppid, comm: stat.slice(open + 1, close), state: rest[0] };
}

/** One line of `ps -o pid=,ppid=,stat=,comm=`. macOS prints comm as a path, which may hold spaces, so it is the rest of the line. */
export function parsePsLine(line: string): Proc | undefined {
  const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
  return m ? { pid: Number(m[1]), ppid: Number(m[2]), state: m[3]!, comm: basename(m[4]!) } : undefined;
}

const hasProc = existsSync("/proc/self");
const PS_FIELDS = "pid=,ppid=,stat=,comm=";

function ps(args: string[]): Proc[] {
  const r = spawnSync("ps", ["-o", PS_FIELDS, ...args], { cwd: homedir(), encoding: "utf8", timeout: 5_000 });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split("\n").flatMap((l) => parsePsLine(l) ?? []);
}

/** The process `pid`, or undefined when it is gone. */
export function readProc(pid: number): Proc | undefined {
  if (hasProc) {
    try {
      return parseStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return undefined;
    }
  }
  return ps(["-p", String(pid)])[0];
}

/** Every process. */
export function listProcs(): Proc[] {
  if (hasProc) {
    return readdirSync("/proc")
      .filter((d) => /^\d+$/.test(d))
      .flatMap((d) => readProc(Number(d)) ?? []);
  }
  return ps(["-A"]);
}

/** Whether `pid` is a live, non-zombie process. */
export const pidAlive = (pid: number): boolean => {
  const p = readProc(pid);
  return !!p && !p.state.startsWith("Z");
};
