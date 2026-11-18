import { existsSync } from "node:fs";
import { spawnAsync } from "./child";
import { exploreDir, exploreRepos, pickerHit, type PickerView, readSelected, renderPicker, showTerminal, SYNC_MS, type TerminalDeps, toggleTerminal, writeSelected, EXPLORE_TAB } from "./explore";
import { defaultMux } from "./mux";
import { selfCommand } from "./paths";
import { loadRepoConfig } from "./project-config";
import { shellInvocation } from "./shell";
import { decodeInput, ENTER_SCREEN, frame, LEAVE_SCREEN } from "./term";
import { topPanel } from "./top-run";
import { errorMessage, exec } from "./util";
import { createPainter } from "./zellij-view";

/** `overbridge explore shell <repo>`: the user's shell in the explore checkout, inside the repo's dev shell when it has one. */
export function exploreShell(repo: string) {
  const dir = exploreDir(repo);
  const argv = [process.env.SHELL || "sh"];
  let spec;

  try {
    spec = loadRepoConfig(dir, repo).shell;
  } catch {
    spec = undefined;
  }

  const inv = shellInvocation(repo, dir, spec, argv);
  process.exit(exec(inv.cmd, { cwd: inv.cwd, env: inv.env }));
}

/** Runs `overbridge explore sync <repo>` as a child so the pane keeps drawing; resolves to a note, empty on success. */
async function sync(repo: string): Promise<string> {
  try {
    const r = await spawnAsync([...selfCommand(), "explore", "sync", repo]);

    return r.code === 0 ? r.stderr.trim() : `sync failed: ${r.stderr.trim() || `exit ${r.code}`}`;
  } catch (e) {
    return `sync failed: ${errorMessage(e)}`;
  }
}

/** Show the picker until a repo is chosen; resolves to it, or exits on `q`. */
function pick(initial: string | undefined, message?: string): Promise<string> {
  const repos = exploreRepos();
  let selected = Math.max(0, initial ? repos.indexOf(initial) : 0);
  let note = message;
  const painter = createPainter((text) => process.stdout.write(text));

  const draw = () => {
    const height = process.stdout.rows ?? 24;
    const width = process.stdout.columns ?? 80;
    const checkedOut = new Set(repos.filter((r) => existsSync(exploreDir(r))));
    const view: PickerView = { repos, selected, checkedOut, width };

    if (note) view.message = note;
    painter.paint(frame(renderPicker(view), height, width));
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
        note = undefined;

        if (input.kind === "click") {
          const i = pickerHit(input.row, repos.length);

          if (i !== undefined) return leave(repos[i]!);
          continue;
        }

        if (input.key === "q" || input.key === "ctrl-c") {
          process.stdout.write(LEAVE_SCREEN);
          process.exit(0);
        } else if (input.key === "j" || input.key === "down") selected = Math.min(repos.length - 1, selected + 1);
        else if (input.key === "k" || input.key === "up") selected = Math.max(0, selected - 1);
        else if ((input.key === "enter" || input.key === " ") && repos[selected]) return leave(repos[selected]!);
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

/**
 * `overbridge explore`: the pane of the @explore tab. Pick a repo, then its top panel (apps, editor, terminal) runs
 * over a checkout of its default branch, with a terminal opened below. `b` goes back to the picker. The checkout is
 * fast-forwarded on pick and every `SYNC_MS` while it is clean.
 */
export async function explorePane() {
  if (!process.stdin.isTTY) throw new Error("overbridge explore needs a terminal");
  const deps: TerminalDeps = { mux: defaultMux(), self: selfCommand() };
  let repo = readSelected();
  let message: string | undefined;

  // a restarted pane goes straight back to the repo it showed
  if (!repo || !existsSync(exploreDir(repo))) repo = await pick(repo);

  for (;;) {
    const chosen: string = repo!;

    if (!existsSync(exploreDir(chosen))) {
      process.stdout.write(`${ENTER_SCREEN}\x1b[1;1Hchecking out ${chosen} on its default branch…`);
      message = await sync(chosen);
      process.stdout.write(LEAVE_SCREEN);

      if (!existsSync(exploreDir(chosen))) {
        repo = await pick(chosen, message);
        continue;
      }
    } else {
      void sync(chosen);
    }

    writeSelected(chosen);
    showTerminal(chosen, deps);
    const timer = setInterval(() => void sync(chosen), SYNC_MS);

    await topPanel(undefined, {
      name: EXPLORE_TAB,
      scope: { dir: exploreDir(chosen), repos: [{ repo: chosen, dir: exploreDir(chosen), claim: {} }], panes: ["terminal"] },
      back: `${chosen} · repos`,
      pane: (kind) => (kind === "terminal" ? toggleTerminal(chosen, deps) : undefined),
    });
    clearInterval(timer);
    repo = await pick(chosen);
  }
}
