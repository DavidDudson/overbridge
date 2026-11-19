import { call, startServer } from "./server-net";
import { exec } from "./util";
import type { PrChecksDeps } from "./pr-checks";

export { prChecks } from "./pr-checks";

/** The fields `gh pr checks` prints, matching `overbridge pr-checks`'s own rows. */
const GH_FIELDS = "name,state,bucket,link";

/** The real server, `gh` and stdio. */
export function defaultPrChecksDeps(): PrChecksDeps {
  return {
    served: async (repo, pr, head) => {
      const r = await call("GET", `/pr-checks?repo=${encodeURIComponent(repo)}&pr=${pr}${head ? `&head=${head}` : ""}`, { timeoutMs: 60_000 });

      if (!r) {
        startServer();

        return undefined;
      }

      // an older server (404) or another build (409) cannot serve it: read GitHub directly, as before
      return r.status === 200 || r.status === 502 ? r : undefined;
    },
    ghChecks: (pr, dir) => exec(["gh", "pr", "checks", String(pr), "--json", GH_FIELDS], { cwd: dir }),
    out: (text) => void process.stdout.write(text),
    err: (text) => console.error(text),
  };
}
