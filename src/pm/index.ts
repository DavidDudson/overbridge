import { githubFactory } from "./github";
import { registerProvider } from "./registry";

/** Register every built-in provider. Runs on import; exported so tests can re-run it after `clearProviders`. */
export function registerBuiltins() {
  registerProvider("github", githubFactory);
}

registerBuiltins();

export { providerFor, registerProvider } from "./registry";
export { cachedTitle, refreshTitle } from "./cache";
export type { Provider, WorkItem } from "./provider";
