# overbridge

Multi-repo workspaces for parallel Claude Code sessions, laid out in zellij.

- **Bare clones, not re-clones.** Each registered repo is cloned once into
  `~/workspaces/.bare/<repo>.git`; every workspace gets a `git worktree` of it.
- **One workspace per work item.** Named for the item (`ENG-123` for Jira, `gh-app-12` for GitHub issue 12 of
  `app`), created by `overbridge start`, wiped when its PR is open and nothing is left locally.
- **Workspaces hold several repos.** `~/workspaces/ENG-123/{app,infra}` etc.
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
  left, the top panel across the top, then the agent. Terminal and diff panes open on demand to the agent's right (top panel buttons). The agent resumes with
  `--continue` when Claude has a transcript for the workspace dir. A file at
  `<zellij config dir>/layouts/overbridge.kdl` replaces the generated layout;
  `overbridge layout` prints what would be used and where it came from.

## Quick start

```nu
overbridge init
overbridge repo add app git@github.com:you/app.git
overbridge repo add infra git@github.com:you/infra.git
overbridge spinup                       # fresh zellij session over the existing workspaces ('scratch' if none)
overbridge start app 12                 # workspace gh-app-12 on the issue's branch, in a new tab running /start-item
overbridge start app ENG-123            # a Jira item: workspace ENG-123
```

`overbridge spinup` always rebuilds the session, killing running panes. Use `overbridge up` to just
attach. `overbridge start` adds a tab to the running session; an item that already has a workspace is
focused instead of started again. Workspaces can also be made by hand: `overbridge new <name> -r app -r infra`.

**Cleanup.** A workspace whose claimed branches all have an open PR, with no uncommitted changes and no
unpushed commits, shows a **Cleanup** button in its top panel. Press it twice within five seconds: it
re-checks, stops the workspace's apps, runs `overbridge rm` and closes the tab. Merged or closed PRs do
not count; the button needs an open one.

Inside a workspace (shell pane or its Claude):

```nu
overbridge checkout app feat/login        # adds repo if missing, claims + switches
overbridge checkout infra '#42'           # pick up a PR
overbridge pr                              # record PRs for claimed branches
overbridge status --all
overbridge release app
```

Run `overbridge help` for every command.

## Layout

```
~/workspaces/               ($OVERBRIDGE_ROOT)
  repos.toml                registry: [repos.<name>] url, default_branch?
  .bare/<repo>.git          bare clones (refspec → refs/remotes/origin/*)
  .overbridge/state.json    claims, lock-protected (.overbridge/state.lock)
  .overbridge/layout.kdl    generated zellij layout (plus agent/, top/, apps state)
  <ws>/                     named for its work item, e.g. gh-app-12
    CLAUDE.md               generated workspace rules
    .claude/settings.json   OVERBRIDGE_NAME env + guard hook
    <repo>/                 worktree
```

## Claude Code plugin

`plugin/` ships skills: `workspace`, `ship-pr` (commit, PR, stacked PRs and splitting a branch into a stack,
green build, Copilot feedback), `workspace-admin`, and the dev loop (`loop-item`, `start-item`,
`scope-item`, `pickup`, `resolve-feedback`, `merge-main`, `rebase-main`), the dependency skills (`update-library`, `audit-vulns`, `loop-tech-debt`) and `read-handoff` (continue from a handoff file after `/clear`). They read the
repo's `overbridge.yml` (`project-management`, `commands`) and work with work items through `overbridge item`.
`loop-tech-debt` files items with `overbridge item create --tech-debt`, so set `project-management.tech-debt`.
`audit-vulns` reads Dependabot alerts, so it needs a GitHub repo. Install:

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

### Keys and defaults

| key | default | meaning |
| --- | --- | --- |
| `version` | `1` | schema version; only `1` exists |
| `project-management.name` | none | `github` or `jira`. Without the block, item features are off |
| `project-management.project` | none | GitHub: `owner/repo` or a Projects v2 number (issues then come from the repo checked out in the workspace). Jira: the project key |
| `project-management.url` | none | Jira site, e.g. `https://example.atlassian.net`; needed for ticket links |
| `project-management.tech-debt` | none | where tech-debt items go: an item id (parent) or `label:<name>`; unset files them with no parent |
| `apps` | `[]` | launchable apps, see [Apps](#apps) |
| `commands.lint`, `typecheck`, `test`, `build`, `format` | none | shell commands the skills run to check a change; a missing one means the repo has none |
| `review.personas` | auto | reviewer personas to run; unset selects by diff signals |
| `review.exclude` | `[]` | personas to skip, applied after selection |
| `review.local-dir` | `.overbridge/personas` | repo-local personas, relative to the repo root |
| `ide` | `$OVERBRIDGE_IDE`, then `$EDITOR` | `vscode`, `zed` or `webstorm`; the top panel's editor button opens the workspace folder. Unset, the button runs `$OVERBRIDGE_IDE` (an ide name or a command) or else `$EDITOR`; set those per user, not in the repo file. GUI editors only, as it is launched detached |

Providers shell out to `gh` (GitHub) and `jira` ([jira-cli](https://github.com/ankitpokhrel/jira-cli), Jira), so there
is no token to store in the config. A branch names its item when it contains the id: `123-title` or
`feat/123-title` for GitHub, `feat/ENG-12-title` for Jira (only the configured project's key counts).

### Examples

A GitHub-managed repo, with checks and one app:

```yaml
version: 1
project-management:
  name: github
  project: owner/repo
commands:
  test: npm test
  lint: npm run lint
apps:
  - id: web
    start: npm run dev -- --port {port}
    ports: [3000, 3001]
    ready: { http: "http://localhost:{port}" }
    open: true
ide: vscode
```

A Jira-managed repo with a tech-debt label and no apps:

```yaml
version: 1
project-management:
  name: jira
  project: ENG
  url: https://example.atlassian.net
  tech-debt: label:tech-debt
commands:
  test: make test
review:
  exclude: [pr-size]
```

[`overbridge.example.yml`](overbridge.example.yml) is a commented copy of every key.

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
its agent state emoji (🆕 empty: just started or cleared, 💤 idle, 🔄 busy, ✅ done, ⏳ done but background tasks still running, ❓ waiting for you, ❌ ended, `·` unknown)
and its item title when cached (no id, no conventional-commit prefix; the workspace name until then), with the key that jumps to it (`⌥1` to `⌥9`, in tab order). Each tab runs its own copy and marks its own tab.
Up/Down or `j`/`k` step to the neighbouring tab, a digit (1-9) jumps, a click picks a row;
the new tab's sidebar takes focus so stepping continues. The list scrolls to keep the
current tab visible. The width comes from the global config:

```toml
# repos.toml
[sidebar]
width = 120   # 12 to 200
```

At the foot sit Claude's usage limits (Hourly = 5-hour window, Weekly), coloured green, yellow or red by
projected usage at reset, and a key legend. Claude's statusline script writes them to
`<meta>/limits.json` as `{"at": <ms>, "fiveHour": {"pct", "resetsAt"}, "weekly": {...}}` (`resetsAt` in epoch
seconds); unknown or over six hours old shows `–`.

`overbridge next` (the `n` key in the sidebar, and a zellij binding) goes to the next tab that needs you:
waiting for input first, then finished, then finished with background tasks running, cycling from the current tab.
#### Agent state

Each workspace's `.claude/settings.json` registers `overbridge hook` for `SessionStart`,
`UserPromptSubmit`, `PostToolUse`, `Notification`, `PreCompact`, `Stop` and `SessionEnd`, next to the guard.
It records `empty` (a session just started or cleared; Claude's later idle notification does not turn it into `waiting`, and the workspace becomes a Cleanup candidate if nothing is uncommitted or unpushed), `idle`, `busy`, `waiting`, `done` or `end` in `<meta>/agent/<ws>.json`. On `Stop` it also records the pids of shells still running under the session (background tasks); `done` reads as `bg` while any is alive. Plan-mode plans are written to `<ws>/plans/` (`plansDirectory` in the generated settings), not `~/.claude/plans`.
The hook
never blocks or fails the agent and loads none of the rest of the CLI. A `busy` state with no
update for 10 minutes (the agent died mid-turn) and any state older than a day show as unknown.
When the top panel's cache is over a minute old, the hook starts one `overbridge top refresh`
in the background, at most once per 30 seconds.

An agent that stops right after an *automatic* compaction (`PreCompact` with trigger `auto`, then `Stop` with no
tool call or prompt between) is restarted: the `Stop` hook blocks the stop once with a "continue where you left off"
reason. Manual `/compact` is left alone.

### Top panel

`overbridge top` is a pane for the top of every tab: the item id and title, a button per
PR and for the item, then at the right the launchers: a toggle per app with its state
(⚫ stopped, 🟡 starting, 🟢 running, 🔴 exited) and port, an editor button (`ide`), and the 🤖 claude / 💻 terminal /
🔀 diff buttons. PR buttons are coloured by status: 🟣 merged, 🟢 mergeable, 🔴 failing build or conflicts,
🟡 build pending, 🔵 blocked (review or behind), ⚫ closed. Claude focuses the agent; terminal opens a shell in
the first repo and diff opens the changes since the default branch (whitespace ignored, rendered by `delta`
from your git config) in a column to the agent's right, and a second press closes them. Click or Enter to
activate, arrows or Tab to move, `o` open a running app, `L` show its log, `r` refresh,
`q` quit. Every button shows its key and the key presses it: `i` the work item, `p` the PR (`u`, `y`, `w`, `z` for more),
`1`-`9` the apps, `e` the editor, `c` `t` `d` claude, terminal and diff, `x` Cleanup. It reads caches and local app records only; `overbridge top refresh` rebuilds
the cache and the panel runs it every minute.
