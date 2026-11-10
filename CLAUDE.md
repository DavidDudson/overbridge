# overbridge

Bun + TypeScript CLI, no runtime deps. `just check` = typecheck + tests.

- `src/cli.ts` is a thin entry with no static imports; `src/main.ts` holds arg dispatch → `src/commands.ts`.
  `overbridge hook` (`src/agent-hook.ts`) runs on every tool call, so it is dispatched before `main.ts`
  loads; keep its imports to `paths.ts`, `agent-state.ts`, `bg-tasks.ts`, `proc.ts` and node builtins.
  Process lookups go through `src/proc.ts` (`/proc` on Linux, `ps` on macOS); never read `/proc` directly.
- Per-repo config: `src/project-config.ts` parses and validates `overbridge.yml` (`overbridge.schema.json` and
  `overbridge.example.yml` must track its keys). The root `config.yml` layers over it (`loadRootLayers`, `resolveConfig`:
  `defaults` < repo file < `repos.<name>`; `config.schema.json` describes it), and top-level `x-*` keys pass through
  for extensions. Load repo config through `loadRepoConfig`/`loadConfigFile` so the layers apply.
  Lifecycle hooks (`src/hooks.ts`, `runHooks`) come only from the root `config.yml`; `validateConfig` rejects them
  in a repo file. Call `runHooks` outside `withState` so a hook can run overbridge. Top panel `buttons` are
  root-only too (`validateConfig`'s `root` option): `refreshTop` runs their `status` into `TopCache.buttons`.
  Global config is `repos.toml` (`src/config.ts`, e.g. `[sidebar] width`).
  Keep code generic: no repo names, ports, URLs or branch conventions outside that config.
  This repo dogfoods its own `overbridge.yml` (checked by `test/config-errors.test.ts`).
- Work items: `src/pm/` (`Provider` interface, `github.ts`, `jira.ts`, title cache); `src/item.ts` is `overbridge item`.
  Providers and apps take injectable runners so tests never need `gh`, `jira` or real processes.
- Apps: `src/apps.ts` (launch, teardown, port pool, status) and `src/app-command.ts` (`overbridge app`).
- Panes: `src/top.ts` (pure model, layout, cache) + `src/top-run.ts` (tty loop); `src/sidebar.ts`; shared terminal
  helpers in `src/term.ts`; the sidebar's bottom border shows `src/version.ts`'s version (package.json's when real,
  else `OVERBRIDGE_VERSION`, which the flake sets to the git rev, else `dev`), read once when the pane starts; `src/agent-state.ts` reads what `src/agent-hook.ts` writes; `src/panes.ts` is the terminal/diff/claude pane toggles and `overbridge diff`; `src/pr-actions.ts` is the top panel's Ready/Draft and Merge (PR or `gh stack`); `src/next.ts` picks the next tab needing attention; `src/limits.ts` reads the usage limits Claude's statusline writes. Pure parts are unit-tested.
- `src/shell.ts` resolves a repo's dev shell (`shell` key): prefix or cached env (`$XDG_CACHE_HOME/overbridge/shell`); used by `overbridge shell`, `claude()` (one repo: agent starts inside it, marker `<meta>/agent/<ws>.shell`), the terminal pane and the generated CLAUDE.md. Keep it tool-agnostic.
- `src/layout.ts` builds the zellij layout (one tab per workspace, `tabKdl`); a user `layouts/overbridge.kdl` replaces it.
- `src/start.ts` is `overbridge start <repo> <id>`: one workspace per work item, named by `Provider.workspaceName`,
  added to the running session with `openTab`. Cleanup (`cleanable`, `pressCleanup` in `src/top.ts`, `wipe` in `src/top-run.ts`)
  offers to remove a workspace whose PRs are open with nothing uncommitted or unpushed.
- `src/guard.ts` is the Claude PreToolUse hook; pure `check()` is unit-tested in `test/guard.test.ts`.
  Exit 2 = block. Fail closed on internal errors. The root `config.yml`'s `guard` block (`GuardConfig`) adds
  `read-paths` (reads only) and `deny` rules; it is never read from a repo file, so a branch can't loosen the guard.
- `src/state.ts`: all claim mutations go through `withState()` (lockfile + atomic rename; throw = no write).
- `test/e2e.test.ts` drives the real CLI against a temp `OVERBRIDGE_ROOT` and a local bare "remote".
- Generated files (`<ws>/.claude/settings.json`, `<ws>/CLAUDE.md`, layout) come from
  `src/scaffold.ts` / `src/layout.ts`; they must stay idempotent.
- `src/stack.ts` reads gh-stack's catalog (`<bare>/gh-stack`); claims cover whole stacks via `cover()`.
- Installed from nix-home's `ws` flake input (to be renamed `overbridge`), which is pinned. After a PR merges to `main`, bump it in
  nix-home (`nix flake update ws`, own commit + PR) or the installed `ws` stays on the old rev.
- Plugin skills in `plugin/skills/`; keep them in sync with CLI commands/flags. Skills mark extension points with
  `ext: <phase>` lines (`src/ext.ts`, `overbridge ext`); a new or renamed phase goes in the skill's Extensions
  section and the README's phase table.
- Review panel is a second plugin, `plugin-review/` (`overbridge-review`): `mob-review`, `review-pr`, `update-personas`,
  `persona-*`. A new persona needs a row in `mob-review`'s panel table; keep its README list in sync.
