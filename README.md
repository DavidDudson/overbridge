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
- **Zellij grid.** `overbridge up` opens a session with 4 workspaces per tab: Claude on top,
  shell below, 8 panes per page.

## Quick start

```nu
overbridge init
overbridge repo add nix-home git@github.com:DavidDudson/nix-home.git
overbridge repo add evergreen git@github.com:DavidDudson/evergreen.git
overbridge spinup                       # 4 empty workspaces (ws1-ws4) + fresh zellij grid
overbridge spinup -p 2                  # 8 workspaces, two tabs
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

`plugin/` ships skills (`workspace`, `ship-pr`, `workspace-admin`):

```
/plugin marketplace add ~/repos/overbridge
/plugin install overbridge@overbridge
```

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
apps: []              # launch/teardown commands, see the apps docs when they land
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
