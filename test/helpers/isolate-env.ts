import { ISOLATED_ENV } from "./isolation";

// Workspace create and remove write Claude's and agy's trust lists, and a test run inside a workspace would
// otherwise reach its real root and name. Only the runner can isolate spawned children, so refuse to run without it.
if (process.env[ISOLATED_ENV] !== "1") {
  throw new Error("Tests must run through test/run.ts so they and the CLIs they spawn never touch the real overbridge root or Claude config. Run `just test [files]` or `bun run test [files]` instead of `bun test`.");
}
