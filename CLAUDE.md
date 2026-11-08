# overbridge

Bun + TypeScript CLI, no runtime deps. `just check` = typecheck + tests.

- `src/cli.ts` arg dispatch → `src/commands.ts`.
- `src/guard.ts` is the Claude PreToolUse hook; pure `check()` is unit-tested in `test/guard.test.ts`.
  Exit 2 = block. Fail closed on internal errors.
- `src/state.ts`: all claim mutations go through `withState()` (lockfile + atomic rename; throw = no write).
- `test/e2e.test.ts` drives the real CLI against a temp `OVERBRIDGE_ROOT` and a local bare "remote".
- Generated files (`<ws>/.claude/settings.json`, `<ws>/CLAUDE.md`, layout) come from
  `src/scaffold.ts` / `src/layout.ts`; they must stay idempotent.
- `src/stack.ts` reads gh-stack's catalog (`<bare>/gh-stack`); claims cover whole stacks via `cover()`.
- Installed from nix-home's `ws` flake input (to be renamed `overbridge`), which is pinned. After a PR merges to `main`, bump it in
  nix-home (`nix flake update ws`, own commit + PR) or the installed `ws` stays on the old rev.
- Plugin skills in `plugin/skills/`; keep them in sync with CLI commands/flags.
