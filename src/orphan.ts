/**
 * Orphans: workspace folders under the root that state does not list, left behind when a removal or a create
 * stopped half way. Their worktrees are still registered in the bare repos, so the branch names stay taken.
 */
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadRepos } from "./config";
import { isOrchestrationTab } from "./orchestration";
import { barePath, isInside, NAME_RE, root, wsDir } from "./paths";
import { PLANS_DIR } from "./scaffold";
import type { State } from "./state";
import { naturalSort, run } from "./util";

/** What overbridge and the OS put in a workspace folder beside the worktrees. */
const GENERATED: readonly string[] = [".claude", "CLAUDE.md", PLANS_DIR, ".DS_Store"];

export interface OrphanWorktree {
  repo: string;
  path: string;
}

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** Paths of the worktrees registered in `repo`'s bare clone, from `git worktree list --porcelain`. */
export function registeredWorktrees(repo: string): string[] {
  const bare = barePath(repo);
  if (!existsSync(bare)) {
    return [];
  }
  return run(["git", "-C", bare, "worktree", "list", "--porcelain"])
    .stdout.split("\n")
    .flatMap((line) => (line.startsWith("worktree ") ? [line.slice("worktree ".length)] : []));
}

/** The registered worktrees of every repo that sit inside `name`'s folder. */
export function worktreesIn(name: string): OrphanWorktree[] {
  const dir = wsDir(name);
  return Object.keys(loadRepos()).flatMap((repo) =>
    registeredWorktrees(repo)
      .filter((path) => isInside(real(path), dir) && real(path) !== dir)
      .map((path) => ({ repo, path: real(path) })),
  );
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Whether `name` is a folder under the root that state does not list and that was a workspace: it holds a
 * registered worktree or the generated `.claude` folder. Any other folder under the root is not overbridge's.
 */
export function isOrphan(name: string, state: State): boolean {
  if (!NAME_RE.test(name) || isOrchestrationTab(name) || state.workspaces[name] || !isDir(wsDir(name))) {
    return false;
  }
  return isDir(join(wsDir(name), ".claude")) || worktreesIn(name).length > 0;
}

/** Every orphan under the root. */
export function orphanNames(state: State): string[] {
  return readdirSync(root())
    .filter((name) => !name.startsWith(".") && isOrphan(name, state))
    .sort(naturalSort);
}

/** Entries of a workspace folder that are neither one of `worktrees` (folder names) nor generated. */
export function strayFiles(dir: string, worktrees: readonly string[]): string[] {
  if (!isDir(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((entry) => !worktrees.includes(entry) && !GENERATED.includes(entry))
    .sort(naturalSort);
}
