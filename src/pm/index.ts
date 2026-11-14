import { githubFactory } from "./github";
import { jiraFactory } from "./jira";
import { registerProvider } from "./registry";

/** Register every built-in provider. Runs on import; exported so tests can re-run it after `clearProviders`. */
export function registerBuiltins() {
  registerProvider("github", githubFactory);
  registerProvider("jira", jiraFactory);
}

registerBuiltins();

export { providerFor, registerProvider } from "./registry";
export { cachedTitle, refreshTitle, TITLE_TTL_MS } from "./cache";
export type { Provider, WorkItem } from "./provider";
