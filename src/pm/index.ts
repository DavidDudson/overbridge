import { githubFactory } from "./github";
import { jiraFactory } from "./jira";
import type { ProjectManagement } from "../project-config";
import type { Provider } from "./provider";
import { providerFor, registerProvider } from "./registry";

/** Register every built-in provider. Runs on import; exported so tests can re-run it after `clearProviders`. */
export function registerBuiltins() {
  registerProvider("github", githubFactory);
  registerProvider("jira", jiraFactory);
}

registerBuiltins();

export { providerFor, registerProvider } from "./registry";

/** The work item id in `branch`, or "" when the repo has no provider or the branch names no item. Reads no network. */
export function itemIdOf(
  pm: ProjectManagement | undefined,
  dir: string,
  branch: string | undefined,
  make: (pm: ProjectManagement, dir: string) => Provider = providerFor,
): string {
  if (!pm || !branch) return "";

  try {
    return make(pm, dir).idFromBranch(branch) ?? "";
  } catch {
    return "";
  }
}

export { cachedTitle, refreshTitle, TITLE_TTL_MS } from "./cache";

export type { Provider, WorkItem } from "./provider";
