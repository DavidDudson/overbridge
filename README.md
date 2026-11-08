# overbridge

Multi-repo workspaces for parallel Claude Code sessions, laid out in zellij.

- **Bare clones, not re-clones.** Each registered repo is cloned once into
  `~/workspaces/.bare/<repo>.git`; every workspace gets a `git worktree` of it.
- **Workspaces hold several repos.** `~/workspaces/ws1/{app,infra}` etc.
- **Claims.** Each workspace tracks the branch/PR it is on per repo. A branch or PR
  claimed by one workspace cannot be checked out by another. A `<type>/<n>-<slug>` branch
  also claims issue `<n>`, so `feat/383-a` and `fix/383-b` cannot be worked in two workspaces.
- **Stacked PRs.** With [gh-stack](https://github.github.com/gh-stack/), a claim covers
  the whole stack (read live from the catalog gh-stack keeps in the bare repo).
  `overbridge checkout <repo> #<pr>` on a stacked PR runs `gh stack checkout`; `gh stack up/down/add`
  move within the claim, and `overbridge pr` moves the claim to the current layer.
- **Bound Claude.** Every workspace gets a generated `.claude/settings.json` with a
  `overbridge guard` PreToolUse hook: no file access in other workspaces, no writes outside
  its own, no raw `git switch`/`checkout <branch>`/`gh pr checkout`/`gh stack checkout`/
  `gh stack trunk`/`git worktree`,
  no workspace admin commands.
- **Zellij tabs.** `overbridge up` opens a session with one tab per workspace: a sidebar down the
  left, the top panel across the top, then the agent above a shell. The agent resumes with
  `--continue` when Claude has a transcript for the workspace dir. A file at
  `<zellij config dir>/layouts/overbridge.kdl` replaces the generated layout;
  `overbridge layout` prints what would be used and where it came from.

## Quick start

```nu
overbridge init
overbridge repo add nix-home git@github.com:DavidDudson/nix-home.git
overbridge repo add evergreen git@github.com:DavidDudson/evergreen.git
overbridge spinup                       # 4 empty workspaces (ws1-ws4) + fresh zellij session
overbridge spinup -n 6                  # 6 workspaces, six tabs
```

`overbridge spinup` always rebuilds the session, killing running panes. Use `overbridge up` to just
attach. Workspaces can also be pre-filled: `overbridge new -r nix-home -r evergreen`.

Inside a workspace (shell pane or its Claude):

```nu
overbridge checkout nix-home feat/zellij   # adds repo if missing, claims + switches
overbridge checkout evergreen '#42'        # pick up a PR
overbridge pr                              # record PRs for claimed branches
overbridge status --all
overbridge release nix-home
```

Run `overbridge help` for every command.

## Layout

```
~/workspaces/               ($OVERBRIDGE_ROOT)
  repos.toml                registry: [repos.<name>] url, default_branch?
  .bare/<repo>.git          bare clones (refspec → refs/remotes/origin/*)
  .ws/state.json            claims, lock-protected (.ws/state.lock)
  .ws/layout.kdl            generated zellij layout
  ws1/
    CLAUDE.md               generated workspace rules
    .claude/settings.json   OVERBRIDGE_NAME env + guard hook
    <repo>/                 worktree
```

## Claude Code plugin

`plugin/` ships skills: `workspace`, `ship-pr`, `workspace-admin`, and the dev loop (`loop-item`, `start-item`,
`scope-item`, `pickup`, `resolve-feedback`, `merge-main`, `rebase-main`). The dev loop reads the repo's `overbridge.yml` (`project-management`, `commands`) and works
with work items through `overbridge item`. Install:

```
/plugin marketplace add ~/repos/overbridge
/plugin install overbridge@overbridge
```

`plugin-review/` is a second plugin, `overbridge-review`, with the review panel: `mob-review`, `review-pr`,
`update-personas` and the `persona-*` reviewers (security, code-quality, naming, comments, error-handling,
architecture, test-design, integration-test, performance, resilience, pr-size, api-design, database,
github-actions, shell, typing, a11y, async-state, ac-check, production-protector, skills). It reads `review.*`
from `overbridge.yml` (see below). Install it next to the first:

```
/plugin install overbridge-review@overbridge
```

`mob-review` uses only the built-in `code-review` skill. `review-pr` claims the PR with `overbridge checkout`.
`loop-item` calls `mob-review` when this plugin is installed. Nothing in it needs `pickup`; `merge-main` and
`resolve-feedback` from `overbridge` are optional extras.

Repo-local personas go in `review.local-dir` (default `.overbridge/personas`) as `<name>/SKILL.md` or `<name>.md`,
in the same format as a built-in. A local persona with a built-in's name replaces it.

## Install

Flake package: `packages.<system>.default` wraps `bun src/cli.ts` and sets `OVERBRIDGE_SELF=overbridge`, so
generated hooks and layouts call `overbridge` on PATH (`ws` is kept as an alias) instead of a store path.

## Environment

| var          | default        | purpose                                    |
| ------------ | -------------- | ------------------------------------------ |
| `OVERBRIDGE_ROOT`    | `~/workspaces` | workspaces root                            |
| `OVERBRIDGE_NAME`    | –              | binds the process to a workspace (Claude)  |
| `OVERBRIDGE_SESSION` | `workspaces`   | zellij session name                        |
| `OVERBRIDGE_SELF`    | script path    | how generated hooks/layouts invoke `overbridge` |

## Limits

The guard is a guardrail, not a sandbox: Bash is checked by pattern (paths into
other workspaces, branch-changing git commands), so an obfuscated command can get
past it. gh aliases (`gh co`) and custom `gh stack alias` names are not recognised.

## Upgrading from `ws`

- The binary is `overbridge`; `ws` stays as an alias.
- `WS_ROOT`, `WS_NAME`, `WS_SELF` and `WS_SESSION` still work but warn. Use the `OVERBRIDGE_*` names.
- `<root>/.ws/` is renamed to `<root>/.overbridge/` automatically on first use.
- The `gh repo list` cache moved to `~/.cache/overbridge/github-repos.json`; refresh it with the command in a workspace's `CLAUDE.md`.

## overbridge.yml

Per-repo rules live in `overbridge.yml` at the repo root. A missing file means defaults.
Editors can use [`overbridge.schema.json`](overbridge.schema.json) for completion.

```yaml
version: 1
project-management:
  name: github        # github | jira
  project: owner/repo # GitHub: owner/repo or project number; Jira: project key
  # url: https://example.atlassian.net   # optional provider base URL
  # tech-debt: 42                        # optional: parent item for tech-debt items, or label:tech-debt
apps: []              # launch/teardown commands, see below
commands:             # all optional; skills run these to check a change
  lint: pnpm lint
  typecheck: pnpm typecheck
  test: pnpm test
  build: pnpm build
  format: pnpm format
review:
  personas: [security, code-quality]   # optional; default is auto-select by diff signals
  exclude: [pr-size]                   # skipped after selection
  local-dir: .overbridge/personas      # repo-local personas (this is the default)
ide: vscode           # vscode | zed | webstorm
```

`overbridge config check [path]` validates a file (unknown keys get a suggestion);
`overbridge config show [path]` prints the resolved config as JSON;
`overbridge config get <key> [path]` prints one value (`commands.test`, `review.local-dir`) and exits non-zero when it is unset.

### Apps

`apps` declares what a repo can launch and tear down. `overbridge app` runs them
from a shell or an agent; the top panel's toggles use the same code.

```yaml
apps:
  - id: web
    label: web                  # defaults to id
    dir: apps/web               # relative to the repo root, defaults to "."
    prepare: pnpm build:libs    # optional, runs to completion before start
    start: pnpm dev --port {port}
    stop: ~                     # optional; default signals the whole process group
    ports: [3000, 3001]         # pool: at most this many workspaces run it at once
    ready: { http: "http://localhost:{port}" }   # or { tcp: "{port}" } / { tcp: 5432 }
    open: true                  # open the browser once ready
    when: feature-branch        # always (default) | feature-branch
```

`{port}` is the port allocated from the pool. Apps run detached in their own
process group, so they outlive the shell that started them and stop as a whole
tree. State lives in `<workspace>/.overbridge/apps/<repo>/<id>.json` and the log
next to it as `<id>.log`. When the pool is used up, the error names the
workspaces holding the ports.

```nu
overbridge app                 # list every app in this workspace with its status
overbridge app web start       # start, wait until ready, open the browser if asked
overbridge app web stop
overbridge app web restart
overbridge app web status      # stopped | starting | running | exited
overbridge app web log         # print the log path
```

Use `--repo <name>` when two repos declare the same id and `--no-wait` to skip the ready check.

### Tab sidebar

`overbridge sidebar` is the pane down the left of every tab. It lists each workspace with
its agent state glyph (`○` idle, `●` busy, `✔` done, `?` waiting, `✖` ended, `·` unknown)
and its item id and title when cached. Each tab runs its own copy and marks its own tab.
Up/Down or `j`/`k` step to the neighbouring tab, a digit (1-9) jumps, a click picks a row;
the new tab's sidebar takes focus so stepping continues. The list scrolls to keep the
current tab visible. The width comes from the global config:

```toml
# repos.toml
[sidebar]
width = 28    # 12 to 80
```

#### Agent state

Each workspace's `.claude/settings.json` registers `overbridge hook` for `SessionStart`,
`UserPromptSubmit`, `PostToolUse`, `Notification`, `Stop` and `SessionEnd`, next to the guard.
It records `idle`, `busy`, `waiting`, `done` or `end` in `<meta>/agent/<ws>.json`. The hook
never blocks or fails the agent and loads none of the rest of the CLI. A `busy` state with no
update for 10 minutes (the agent died mid-turn) and any state older than a day show as unknown.
When the top panel's cache is over a minute old, the hook starts one `overbridge top refresh`
in the background, at most once per 30 seconds.

### Top panel

`overbridge top` is a pane for the top of every tab: the item id and title, a button per
PR and for the item, an editor button (`ide`), and a toggle per app with its state
(`○` stopped, `◐` starting, `●` running, `✖` exited) and port. Click or Enter to
activate, arrows or Tab to move, `o` open a running app, `L` show its log, `r` refresh,
`q` quit. It reads caches and local app records only; `overbridge top refresh` rebuilds
the cache and the panel runs it every minute.
