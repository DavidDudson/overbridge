# overbridge

Bun + TypeScript CLI, no runtime deps. `just check` = typecheck + tests.

- `src/cli.ts` is a thin entry with no static imports; `src/main.ts` holds arg dispatch → `src/commands.ts`.
  `overbridge hook` (`src/agent-hook.ts`) runs on every tool call, so it is dispatched before `main.ts`
  loads; keep its imports to `paths.ts`, `agent-state.ts` and node builtins.
- Per-repo config: `src/project-config.ts` parses and validates `overbridge.yml` (`overbridge.schema.json` and
  `overbridge.example.yml` must track its keys); global config is `repos.toml` (`src/config.ts`, e.g. `[sidebar] width`).
  Keep code generic: no repo names, ports, URLs or branch conventions outside that config.
- Work items: `src/pm/` (`Provider` interface, `github.ts`, `jira.ts`, title cache); `src/item.ts` is `overbridge item`.
  Providers and apps take injectable runners so tests never need `gh`, `jira` or real processes.
- Apps: `src/apps.ts` (launch, teardown, port pool, status) and `src/app-command.ts` (`overbridge app`).
- Panes: `src/top.ts` (pure model, layout, cache) + `src/top-run.ts` (tty loop); `src/sidebar.ts`; shared terminal
  helpers in `src/term.ts`; `src/agent-state.ts` reads what `src/agent-hook.ts` writes. Pure parts are unit-tested.
- `src/layout.ts` builds the zellij layout (one tab per workspace); a user `layouts/overbridge.kdl` replaces it.
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
- Review panel is a second plugin, `plugin-review/` (`overbridge-review`): `mob-review`, `review-pr`, `update-personas`,
  `persona-*`. A new persona needs a row in `mob-review`'s panel table; keep its README list in sync.
