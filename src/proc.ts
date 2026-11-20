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

/** Whether `pid` exists at all, zombies included, without starting a process. */
const signalable = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to another user
    return e instanceof Error && "code" in e && e.code === "EPERM";
  }
};

/** The live, non-zombie processes among `pids`, as `pidAlive` judges each, with at most one `ps` on macOS. */
export function pidsAlive(pids: readonly number[]): Set<number> {
  const existing = [...new Set(pids)].filter((pid) => pid > 0 && signalable(pid));

  if (hasProc || existing.length === 0) {
    return new Set(existing.filter(pidAlive));
  }

  return aliveFromPs(existing, spawnSync("ps", ["-o", PS_FIELDS, "-p", existing.join(",")], { cwd: homedir(), encoding: "utf8", timeout: 5_000 }));
}

/** What a `ps -p` run returned, as much of it as `aliveFromPs` reads. */
export interface PsResult {
  status: number | null;
  stdout?: string | null;
  error?: Error;
}

/** The pids in `existing` (each answered `kill(pid, 0)`) that `ps` does not list as zombies. */
export function aliveFromPs(existing: readonly number[], r: PsResult): Set<number> {
  // ps exits 1 when none of the pids is listed; a timeout or a crash leaves no status, and then a reap would kill every run
  if (r.status === null || r.error) {
    return new Set(existing);
  }

  const zombies = new Set(
    (r.stdout ?? "")
      .split("\n")
      .flatMap((l) => parsePsLine(l) ?? [])
      .filter((p) => p.state.startsWith("Z"))
      .map((p) => p.pid),
  );

  return new Set(existing.filter((pid) => !zombies.has(pid)));
}

/** One process of a group listing: its group, state letters and CPU seconds used so far. */
export interface GroupProc {
  pgid: number;
  state: string;
  cpuSeconds: number;
}

/**
 * CPU time as `ps -o time=` prints it: `[[dd-]hh:]mm:ss` on Linux, `mm:ss.cc` (minutes may pass 59) on macOS.
 * NaN when it is not a time.
 */
export function parseCpuTime(text: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());

  if (!match) {
    return Number.NaN;
  }

  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;

  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

/** One line of `ps -A -o pgid=,stat=,time=`. */
export function parseGroupLine(line: string): GroupProc | undefined {
  const match = /^\s*(\d+)\s+(\S+)\s+(\S+)\s*$/.exec(line);

  if (!match) {
    return undefined;
  }

  const cpuSeconds = parseCpuTime(match[3]!);

  return Number.isNaN(cpuSeconds) ? undefined : { pgid: Number(match[1]), state: match[2]!, cpuSeconds };
}

/** The live (non-zombie) processes of group `pgid`; undefined when `ps` fails. */
function groupMembers(pgid: number): GroupProc[] | undefined {
  const r = spawnSync("ps", ["-A", "-o", "pgid=,stat=,time="], { encoding: "utf8", timeout: 5_000 });

  if (r.status !== 0 || !r.stdout) {
    return undefined;
  }

  return r.stdout
    .split("\n")
    .flatMap((line) => parseGroupLine(line) ?? [])
    .filter((p) => p.pgid === pgid && !p.state.startsWith("Z"));
}

/** True while any non-zombie process is in the group, even after its leader exits. */
export function groupAlive(pgid: number): boolean {
  const members = groupMembers(pgid);

  if (members) {
    return members.length > 0;
  }

  try {
    process.kill(-pgid, 0);

    return true;
  } catch {
    return false;
  }
}

/** Total CPU seconds used so far by the live processes of group `pgid`. */
export const groupCpuSeconds = (pgid: number): number =>
  (groupMembers(pgid) ?? []).reduce((total, p) => total + p.cpuSeconds, 0);

/** A process with its nice value and the value of one environment variable it started with. */
export interface EnvProc extends Proc {
  nice: number;
  /** Unset when the process has no such variable, or its environment cannot be read. */
  env?: string;
}

/** The last `name=value` in `text`; values hold no spaces, as workspace names never do. */
function envValue(text: string, name: string): string | undefined {
  const matches = [...text.matchAll(new RegExp(`(?:^|\\s)${name}=(\\S*)`, "g"))];

  return matches.at(-1)?.[1];
}

/**
 * One line of `ps -E -o pid=,ppid=,nice=,stat=,command=`. macOS appends the environment to the command line, so the
 * variable is the last `name=` on it, and the executable is the command's first word.
 */
export function parseEnvPsLine(line: string, name: string): EnvProc | undefined {
  const m = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)(.*)$/.exec(line);

  if (!m) {
    return undefined;
  }

  const proc: EnvProc = { pid: Number(m[1]), ppid: Number(m[2]), nice: Number(m[3]), state: m[4]!, comm: basename(m[5]!) };
  const env = envValue(m[6]!, name);

  return env === undefined ? proc : { ...proc, env };
}

/** `/proc/<pid>/stat` plus its `environ`. The nice value is field 19 of `proc(5)`: index 16 once the text after `comm)` is split on spaces. */
function readEnvProc(pid: number, name: string): EnvProc | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const proc = parseStat(pid, stat);
    const nice = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[16]);

    if (!proc || Number.isNaN(nice)) {
      return undefined;
    }

    const env = readEnviron(pid, name);

    return env === undefined ? { ...proc, nice } : { ...proc, nice, env };
  } catch {
    return undefined;
  }
}

function readEnviron(pid: number, name: string): string | undefined {
  try {
    const prefix = `${name}=`;

    const entry = readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .find((e) => e.startsWith(prefix));

    return entry?.slice(prefix.length);
  } catch {
    return undefined;
  }
}

/** Every process with its nice value and environment variable `name` (readable for this user's processes only); undefined when `ps` fails. */
export function listEnvProcs(name: string): EnvProc[] | undefined {
  if (hasProc) {
    return readdirSync("/proc")
      .filter((d) => /^\d+$/.test(d))
      .flatMap((d) => readEnvProc(Number(d), name) ?? []);
  }

  const r = spawnSync("ps", ["-AE", "-o", "pid=,ppid=,nice=,stat=,command="], { cwd: homedir(), encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024 * 1024 });

  if (r.status !== 0 || !r.stdout) {
    return undefined;
  }

  return r.stdout.split("\n").flatMap((l) => parseEnvPsLine(l, name) ?? []);
}

/**
 * The thread ids of `pid`, for a renice that has to reach every thread: Linux keeps a nice per thread, so
 * `renice -p <pid>` alone leaves the threads that already exist where they were. macOS sets it per process.
 */
export function threadIds(pid: number): number[] {
  if (!hasProc) {
    return [pid];
  }

  try {
    return readdirSync(`/proc/${pid}/task`).flatMap((t) => (/^\d+$/.test(t) ? [Number(t)] : []));
  } catch {
    return [pid];
  }
}
