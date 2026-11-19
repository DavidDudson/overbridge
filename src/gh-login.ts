import { run, type RunResult } from "./util";
import { cachedGhLogin } from "./value-cache";

/** Who `gh` is signed in as, read once an hour (`cachedGhLogin`). A caller that injects its own runner (a test) is not cached. */
export function githubLogin(runner: (cmd: string[]) => RunResult = run): string {
  let failure = "";

  const read = () => {
    const who = runner(["gh", "api", "user", "--jq", ".login"]);
    failure = (who.stderr || who.stdout).trim().split("\n")[0] ?? "";

    return who.ok && who.stdout.trim() ? who.stdout.trim() : undefined;
  };

  const me = runner === run ? cachedGhLogin(read) : read();

  if (!me) {
    throw new Error(`gh api user failed: ${failure || "gh printed nothing"}`);
  }

  return me;
}
