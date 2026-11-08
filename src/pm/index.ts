import { githubFactory } from "./github";
import { registerProvider } from "./registry";

/** Register every built-in provider. Call once at startup, before `providerFor`. */
export function registerBuiltinProviders() {
  registerProvider("github", githubFactory);
}

export { providerFor } from "./registry";
