import { existsSync } from "node:fs";
import { killApp, recordIds, stopApp } from "./apps";
import { spawnAsync } from "./child";
import { getRepo } from "./config";
import { exploreDir, exploreRepos, pickerHit, type PickerView, readSelected, renderPicker, showTerminal, singleFlight, SYNC_MS, type TerminalDeps, toggleTerminal, writeSelected } from "./explore";
import * as git from "./git";
import { defaultMux } from "./mux";
import { EXPLORE_TAB } from "./orchestration";
import { selfCommand } from "./paths";
import { loadRepoConfig } from "./project-config";
import { shellInvocation } from "./shell";
import { decodeInput, ENTER_SCREEN, frame, LEAVE_SCREEN } from "./term";
import { PanelExit, type PanelOptions, topPanel } from "./top-run";
import { errorMessage, exec } from "./util";
import { createPainter, isFocused, readView } from "./zellij-view";

/** `overbridge explore shell <repo>`: the user's shell in the explore checkout, inside the repo's dev shell when it has one. */
export function exploreShell(repo: string) {
  const dir = exploreDir(repo);
  let spec;

  try {
    spec = loadRepoConfig(dir, repo).shell;
  } catch (e) {
    process.stderr.write(`overbridge explore: ${repo}'s config did not load (${errorMessage(e)}); starting a shell without its dev shell\n`);
    spec = undefined;
  }

  const inv = shellInvocation(repo, dir, spec, [process.env.SHELL || "sh"]);
  process.exit(exec(inv.cmd, { cwd: inv.cwd, env: inv.env }));
}

async function runSync(repo: string): Promise<string> {
  try {
    const r = await spawnAsync([...selfCommand(), "explore", "sync", repo]);

    return r.code === 0 ? r.stderr.trim() : `sync failed: ${r.stderr.trim() || `exit ${r.code}`}`;
  } catch (e) {
    return `sync failed: ${errorMessage(e)}`;
  }
}

/**
 * Runs `overbridge explore sync <repo>` as a child so the pane keeps drawing; resolves to a message, empty on success.
 * A sync already running for `repo` is joined, so two never fetch or check out the same worktree at once.
 */
const sync = singleFlight(runSync);

/** Stop every explore app of `repo`, so a repo you have left holds no pool port. Returns what failed, for the panel. */
function stopExploreApps(repo: string): string | undefined {
  const dir = exploreDir(repo);
  let specs;

  try {
    specs = loadRepoConfig(dir, repo).apps;
  } catch (e) {
    for (const id of recordIds(EXPLORE_TAB, repo)) killApp(EXPLORE_TAB, repo, id);

    return `${repo}'s config did not load (${errorMessage(e)}), so its apps were killed without their stop commands`;
  }

  const configured = new Set(specs.map((spec) => spec.id));

  const failed = specs.flatMap((spec) => {
    try {
      stopApp(EXPLORE_TAB, repo, spec, dir);

      return [];
    } catch (e) {
      return [`${spec.id} (${errorMessage(e)})`];
    }
  });

  // a sync can drop an app from the config while it runs; its record still names the process to stop
  for (const id of recordIds(EXPLORE_TAB, repo).filter((id) => !configured.has(id))) killApp(EXPLORE_TAB, repo, id);

  return failed.length ? `could not stop ${repo}'s ${failed.join(", ")}` : undefined;
}

/**
 * A message row a background sync can report to before the panel has opened: what arrives early is held and shown
 * once the panel hands over its `show`.
 */
function messageSink() {
  let show: ((message: string) => void) | undefined;
  let held: string | undefined;

  return {
    report: (message: string) => {
      if (!message) return;

      if (show) show(message);
      else held = message;
    },
    bind: (next: (message: string) => void) => {
      show = next;

      if (held) next(held);
      held = undefined;
    },
  };
}

/** Show the picker until a repo is chosen; resolves to it, or exits on `q`. */
function pick(initial: string | undefined, initialMessage?: string): Promise<string> {
  const repos = exploreRepos();
  let selected = Math.max(0, initial ? repos.indexOf(initial) : 0);
  let message = initialMessage;
  const painter = createPainter((text) => process.stdout.write(text));
  const height = () => process.stdout.rows ?? 24;

  const draw = () => {
    const width = process.stdout.columns ?? 80;
    const checkedOut = new Set(repos.filter((r) => existsSync(exploreDir(r))));
    const view: PickerView = { repos, selected, checkedOut, width, height: height() };

    if (message) view.message = message;
    painter.paint(frame(renderPicker(view), height(), width));
  };

  return new Promise((resolve) => {
    const leave = (repo: string) => {
      process.stdin.removeAllListeners("data");
      process.stdout.removeAllListeners("resize");
      process.stdout.write(LEAVE_SCREEN);
      resolve(repo);
    };

    process.stdout.write(ENTER_SCREEN);
    painter.invalidate();
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", (data) => {
      for (const input of decodeInput(data.toString())) {
        message = undefined;

        if (input.kind === "click") {
          const hit = pickerHit(input.row, repos, selected, height());

          if (hit !== undefined) return leave(hit);
          continue;
        }

        const current = repos[selected];

        if (input.key === "q" || input.key === "ctrl-c") {
          process.stdout.write(LEAVE_SCREEN);
          process.exit(0);
        } else if (input.key === "j" || input.key === "down") selected = Math.min(repos.length - 1, selected + 1);
        else if (input.key === "k" || input.key === "up") selected = Math.max(0, selected - 1);
        else if ((input.key === "enter" || input.key === " ") && current !== undefined) return leave(current);
      }

      draw();
    });
    process.stdout.on("resize", () => {
      painter.invalidate();
      draw();
    });
    draw();
  });
}

/** The repo to open first: the last one picked while its checkout is still there, else the picker's choice. */
async function firstRepo(): Promise<string> {
  const last = readSelected();

  return last && existsSync(exploreDir(last)) ? last : pick(last);
}

/** The @explore pane: a repo picker, then the top panel and a terminal over that repo's default-branch checkout. */
export async function explorePane() {
  if (!process.stdin.isTTY) throw new Error("overbridge explore needs a terminal");
  const deps: TerminalDeps = { mux: defaultMux(), self: selfCommand() };
  let repo = await firstRepo();
  let shown: string | undefined;

  for (;;) {
    const chosen = repo;
    let message: string | undefined;
    let justSynced = false;

    if (!existsSync(exploreDir(chosen))) {
      process.stdout.write(`${ENTER_SCREEN}\x1b[1;1Hchecking out ${chosen} on ${git.defaultBranch(getRepo(chosen))}…`);
      message = await sync(chosen);
      justSynced = true;
      process.stdout.write(LEAVE_SCREEN);

      if (!existsSync(exploreDir(chosen))) {
        repo = await pick(chosen, message);
        continue;
      }
    }

    if (shown !== undefined && shown !== chosen) message = stopExploreApps(shown) ?? message;
    writeSelected(chosen);

    // the terminal opens on a new repo only, so one the user closed stays closed on a return to the same repo
    if (shown !== chosen) message = showTerminal(chosen, deps) ?? message;
    shown = chosen;

    const sink = messageSink();

    if (!justSynced) void sync(chosen).then(sink.report);

    const timer = setInterval(() => {
      if (isFocused(EXPLORE_TAB, readView())) void sync(chosen).then(sink.report);
    }, SYNC_MS);

    const panel: PanelOptions = {
      name: EXPLORE_TAB,
      scope: { dir: exploreDir(chosen), repos: [{ repo: chosen, dir: exploreDir(chosen), claim: { branch: git.defaultBranch(getRepo(chosen)) } }], panes: ["terminal"] },
      back: `${chosen} · repos`,
      pane: () => toggleTerminal(chosen, deps),
      onMessage: sink.bind,
    };

    if (message) panel.message = message;

    let exit: PanelExit;

    try {
      exit = await topPanel(undefined, panel);
    } finally {
      clearInterval(timer);
    }

    if (exit === PanelExit.Quit) process.exit(0);
    repo = await pick(chosen);
  }
}
