import { PM_NAMES, type PmName, type ProjectManagement } from "../project-config";
import { fail } from "../util";
import type { Provider, ProviderFactory } from "./provider";

const factories = new Map<PmName, ProviderFactory>();

/** Register the implementation behind a `project-management.name`. */
export function registerProvider(name: PmName, factory: ProviderFactory) {
  factories.set(name, factory);
}

/** The provider for a repo's config. `cwd` is a worktree of the repo. */
export function providerFor(config: ProjectManagement, cwd: string): Provider {
  const factory = factories.get(config.name);
  if (!factory) {
    const known = PM_NAMES.filter((n) => factories.has(n));
    fail(`project-management provider '${config.name}' is not available${known.length ? ` (available: ${known.join(", ")})` : ""}`);
  }
  return factory(config, cwd);
}

/** Test hook: drop every registration. */
export function clearProviders() {
  factories.clear();
}
