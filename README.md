# ws

Multi-repo workspaces for parallel Claude Code sessions, laid out in zellij.

- **Bare clones, not re-clones.** Each registered repo is cloned once into
  `~/workspaces/.bare/<repo>.git`; every workspace gets a `git worktree` of it.
- **Workspaces hold several repos.** `~/workspaces/ws1/{app,infra}` etc.
- **Claims.** Each workspace tracks the branch/PR it is on per repo. A branch or PR
  claimed by one workspace cannot be checked out by another.
- **Stacked PRs.** With [gh-stack](https://github.github.com/gh-stack/), a claim covers
  the whole stack (read live from the catalog gh-stack keeps in the bare repo).
  `ws checkout <repo> #<pr>` on a stacked PR runs `gh stack checkout`; `gh stack up/down/add`
  move within the claim, and `ws pr` moves the claim to the current layer.
- **Bound Claude.** Every workspace gets a generated `.claude/settings.json` with a
  `ws guard` PreToolUse hook: no file access in other workspaces, no writes outside
  its own, no raw `git switch`/`checkout <branch>`/`gh pr checkout`/`gh stack checkout`/
  `gh stack trunk`/`git worktree`,
  no workspace admin commands.
- **Zellij grid.** `ws up` opens a session with 4 workspaces per tab: Claude on top,
  shell below, 8 panes per page.

## Quick start

```nu
ws init
ws repo add nix-home git@github.com:DavidDudson/nix-home.git
ws repo add evergreen git@github.com:DavidDudson/evergreen.git
ws spinup                       # 4 empty workspaces (ws1-ws4) + fresh zellij grid
ws spinup -p 2                  # 8 workspaces, two tabs
```

`ws spinup` always rebuilds the session, killing running panes. Use `ws up` to just
attach. Workspaces can also be pre-filled: `ws new -r nix-home -r evergreen`.

Inside a workspace (shell pane or its Claude):

```nu
ws checkout nix-home feat/zellij   # adds repo if missing, claims + switches
ws checkout evergreen '#42'        # pick up a PR
ws pr                              # record PRs for claimed branches
ws status --all
ws release nix-home
```

Run `ws help` for every command.

## Layout

```
~/workspaces/               ($WS_ROOT)
  repos.toml                registry: [repos.<name>] url, default_branch?
  .bare/<repo>.git          bare clones (refspec → refs/remotes/origin/*)
  .ws/state.json            claims, lock-protected (.ws/state.lock)
  .ws/layout.kdl            generated zellij layout
  ws1/
    CLAUDE.md               generated workspace rules
    .claude/settings.json   WS_NAME env + guard hook
    <repo>/                 worktree
```

## Claude Code plugin

`plugin/` ships skills (`workspace`, `ship-pr`, `workspace-admin`):

```
/plugin marketplace add ~/repos/ws
/plugin install ws@ws
```

## Install

Flake package: `packages.<system>.default` wraps `bun src/cli.ts` and sets `WS_SELF=ws`, so
generated hooks and layouts call `ws` on PATH instead of a store path.

## Environment

| var          | default        | purpose                                    |
| ------------ | -------------- | ------------------------------------------ |
| `WS_ROOT`    | `~/workspaces` | workspaces root                            |
| `WS_NAME`    | –              | binds the process to a workspace (Claude)  |
| `WS_SESSION` | `workspaces`   | zellij session name                        |
| `WS_SELF`    | script path    | how generated hooks/layouts invoke `ws`    |

## Limits

The guard is a guardrail, not a sandbox: Bash is checked by pattern (paths into
other workspaces, branch-changing git commands), so an obfuscated command can get
past it. gh aliases (`gh co`) and custom `gh stack alias` names are not recognised.
