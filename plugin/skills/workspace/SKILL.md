---
name: workspace
description: Work inside a ws workspace — check which workspace/branch/PR you are on, switch to a branch, pick up a PR, or release a branch. Use when the session is bound to a ws workspace ($WS_NAME set or cwd under ~/workspaces/<ws>) and the user says "work on branch X", "pick up PR #N", "start a feature", "what am I on", "switch branch", or "free this branch".
---

# Working in a ws workspace

Sessions launched by `ws` are bound to one workspace (`$WS_NAME`). A `ws guard`
PreToolUse hook enforces this; treat a guard block as a hard rule, never work around it.

## Orient first

```sh
ws whoami          # workspace name
ws status          # repos in this workspace: claimed branch, PR, actual head, dirty
ws status --all    # every workspace (read-only view of other claims)
```

Each subdirectory of the workspace is a git worktree of one repo. A workspace can
start empty: `ws repo ls` shows registered repos, `ws checkout <repo> <branch>`
adds the repo to this workspace on first use, and `ws repo add <name> <url>`
registers a new one (ask the user before registering).

## Change branch / pick up a PR

Always via `ws checkout`. It fetches, checks the claim, switches, and records it.

```sh
ws checkout <repo> <branch>     # existing local/remote branch, or new branch off origin/<default>
ws checkout <repo> #123         # PR by number (fork PRs land on local branch pr-123)
ws checkout <repo> <pr-url>
ws checkout <branch>            # repo omitted when the workspace has exactly one repo
```

Never use `git switch`, `git checkout <branch>`, `gh pr checkout` or `git worktree`.
Use `git restore <path>` (or `git checkout -- <path>`) to discard file changes.

If `ws checkout` says the branch or PR is **claimed by workspace X**: stop and tell
the user. Do not create a near-duplicate branch name to dodge the claim.

## Branch naming

New branches: short kebab-case with a type prefix, e.g. `feat/zellij-layout`,
`fix/guard-symlinks`. Ask if the user has a ticket/issue to reference.

## Done with a branch

```sh
ws release <repo>   # detaches the worktree in place and frees the claim
```

Release only when the user says the work is finished or abandoned. Uncommitted
changes stay in the worktree.
