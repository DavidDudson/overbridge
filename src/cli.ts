#!/usr/bin/env bun
// Entry point. Kept free of static imports: `hook` runs on every Claude tool call and must not
// load the rest of the CLI, so each branch imports only what it needs.
export {};
const argv = Bun.argv.slice(2);

if (argv[0] === "hook") {
  const { hookMain } = await import("./agent-hook");
  process.exit(await hookMain());
}
const { run } = await import("./main");
await run(argv);
