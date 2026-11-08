import { appAvailable, appStatus, appUrl, logPath, openBrowser, readRecord, startApp, stopApp, waitReady } from "./apps";
import { requireWs } from "./commands";
import { worktreePath } from "./paths";
import { loadRepoConfig } from "./project-config";
import { getWorkspace, readState } from "./state";
import { fail, log } from "./util";

const READY_TIMEOUT_MS = 60_000;

const USAGE = "usage: overbridge app [<id> [start|stop|restart|status|log]] [--repo name] [--no-wait]";

/**
 * `overbridge app [<id> [start|stop|restart|status|log]]`: the apps declared in
 * the overbridge.yml of each repo in the workspace. No id lists them all.
 */
export async function appCommand(wsOpt: string | undefined, repoOpt: string | undefined, id?: string, action = "status", noWait = false) {
  const ws = requireWs(wsOpt);
  const repos = Object.keys(getWorkspace(readState(), ws).repos).filter((r) => !repoOpt || r === repoOpt);
  const found = repos.flatMap((repo) => {
    const dir = worktreePath(ws, repo);
    return loadRepoConfig(dir, repo).apps.map((spec) => ({ repo, dir, spec }));
  });

  const describe = async (f: (typeof found)[number]) => {
    const status = await appStatus(ws, f.repo, f.spec);
    const record = readRecord(ws, f.repo, f.spec.id);
    const port = record?.port === undefined ? "" : ` :${record.port}`;
    const hint = appAvailable(f.spec, f.repo, f.dir) ? "" : " (needs a feature branch)";
    return `${f.repo}/${f.spec.id}: ${status}${status === "stopped" ? "" : port}${hint}`;
  };

  if (!id) {
    if (!found.length) return log(`no apps declared in ${ws}; add an \`apps:\` list to a repo's overbridge.yml`);
    for (const f of found) console.log(await describe(f));
    return;
  }

  const matches = found.filter((f) => f.spec.id === id);
  if (!matches.length) fail(`no app '${id}' in ${ws}${found.length ? ` (apps: ${found.map((f) => f.spec.id).join(", ")})` : ""}`);
  if (matches.length > 1) fail(`app '${id}' is declared in ${matches.map((m) => m.repo).join(" and ")}; pass --repo`);
  const app = matches[0]!;

  const start = async () => {
    const record = startApp(ws, app.repo, app.spec, app.dir);
    log(`started ${app.spec.id} (pid ${record.pid}${record.port === undefined ? "" : `, port ${record.port}`}); log: ${logPath(ws, app.repo, app.spec.id)}`);
    if (noWait || !app.spec.ready) return;
    if (!(await waitReady(app.spec, record, READY_TIMEOUT_MS))) {
      const dead = (await appStatus(ws, app.repo, app.spec)) === "exited";
      fail(dead ? `${app.spec.id} exited before it was ready; see ${logPath(ws, app.repo, app.spec.id)}` : `${app.spec.id} not ready after ${READY_TIMEOUT_MS / 1000}s`);
    }
    const url = appUrl(app.spec, record.port);
    log(`${app.spec.id} is ready${url ? ` at ${url}` : ""}`);
    if (app.spec.open && url) openBrowser(url);
  };
  const stop = () => log(stopApp(ws, app.repo, app.spec, app.dir) ? `stopped ${app.spec.id}` : `${app.spec.id} is not running`);

  switch (action) {
    case "start":
      return start();
    case "stop":
      return stop();
    case "restart":
      stop();
      return start();
    case "status":
      return console.log(await describe(app));
    case "log":
      return console.log(logPath(ws, app.repo, app.spec.id));
    default:
      return fail(USAGE);
  }
}
