import { spawnCwd } from "./util";

/** Exit code and stderr of a finished command. */
export interface Finished {
  code: number;
  stderr: string;
}

export type Spawner = (cmd: string[]) => Promise<Finished>;

/** Run `cmd` with no stdin or stdout, so it never draws over a pane, and collect its stderr. */
export const spawnAsync: Spawner = async (cmd) => {
  const p = Bun.spawn({ cmd, cwd: spawnCwd(), stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);

  return { code, stderr };
};

/** The last non-empty stderr line without the CLI's `overbridge: ` prefix, else a line naming `what` and the exit code. */
export function childError(what: string, result: Finished): string {
  const last = result.stderr.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);

  return last?.replace(/^overbridge: /, "") ?? `${what} failed with exit code ${result.code}`;
}
