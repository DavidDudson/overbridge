---
name: workspace
description: Work inside an overbridge workspace — check which workspace/branch/PR you are on, switch to a branch, pick up a PR, or release a branch. Use when the session is bound to an overbridge workspace ($OVERBRIDGE_NAME set or cwd under ~/workspaces/<ws>) and the user says "work on branch X", "pick up PR #N", "start a feature", "what am I on", "switch branch", or "free this branch".
---

# Working in an overbridge workspace

Sessions launched by `overbridge` are bound to one workspace (`$OVERBRIDGE_NAME`). An `overbridge guard`
PreToolUse hook enforces this; treat a guard block as a hard rule, never work around it.

## Orient first

```sh
overbridge whoami          # workspace name
overbridge status          # repos in this workspace: claimed branch, PR, actual head, dirty
overbridge status --all    # every workspace (read-only view of other claims)
```

Each subdirectory of the workspace is a git worktree of one repo. A workspace can
start empty: `overbridge repo ls` shows registered repos, `overbridge checkout <repo> <branch>`
adds the repo to this workspace on first use, and `overbridge repo add <name> <url>`
registers a new one (ask the user before registering).

## Repo config

Each repo can carry an `overbridge.yml` (work-item provider, apps, check commands, review, ide).
Read it with `overbridge config show [dir]` or one value with `overbridge config get <key> [dir]`.
A repo with a `shell` key has a dev shell: run its tools as `overbridge shell <repo> -- <cmd>` (it runs the command as it is when the repo has none).
Run `commands.lint`, `typecheck`, `test`, and `build` as `overbridge check <repo> -- <cmd>`. It queues them across workspaces and runs several at once while the load allows, in the same dev shell. The `check-queue` key sets its load limit, `max-parallel`, and timeouts.
Apps it declares run with `overbridge app` (list), `overbridge app <id> start|stop|restart|status|log`.
`overbridge item from-branch` names the work item the current branch belongs to.
The top panel and sidebar show this state; do not edit `.overbridge/` under the workspaces root by hand.

## Change branch / pick up a PR

Always via `overbridge checkout`. It fetches, checks the claim, switches, and records it.

```sh
overbridge checkout <repo> <branch>     # existing local/remote branch, or new branch off origin/<default>
overbridge checkout <repo> #123         # PR by number (fork PRs land on local branch pr-123)
overbridge checkout <repo> <pr-url>
overbridge checkout <branch>            # repo omitted when the workspace has exactly one repo
```

Never use `git switch`, `git checkout <branch>`, `gh pr checkout` or `git worktree`.
Use `git restore <path>` (or `git checkout -- <path>`) to discard file changes.

If `overbridge checkout` says the branch, PR or issue is **claimed by workspace X**: stop and tell
the user. Do not create a near-duplicate branch name to dodge the claim. Name branches
`<type>/<issue>-<slug>` (`feat/383-iwr`): the issue number is part of the claim, so a
second branch for the same issue is refused.

## Stacked PRs (gh stack)

A claim covers a whole [gh-stack](https://github.github.com/gh-stack/) stack: every
layer, every layer's PR. The stack catalog lives in the shared bare repo, so other
workspaces see the stack and cannot check out any of its layers.

```sh
overbridge checkout <repo> #123          # 123 is stacked → runs `gh stack checkout`, claims every layer
gh stack init feat/auth          # start a stack here (from a claimed or detached worktree)
gh stack add feat/api            # new layer on top
gh stack up | down | top | bottom
gh stack submit --auto           # push + open/update every PR
overbridge pr <repo>                     # claim follows HEAD to the current layer, records its PR
```

`gh stack checkout` and `gh stack trunk` are blocked: the first bypasses claims, the
second puts the workspace on the shared default branch. Use the `gh-stack` skill for
everything else (non-interactive flags, rebase/conflict flow, merge).

## One workspace per item

Workspaces are named for the work item they exist for (`ENG-123`, `gh-app-12`). To start a different
item, do not switch this workspace: `overbridge start <repo> <id>` makes the item's own workspace and tab
(see `start-item`). Related work stays here: when this workspace is on a `task/` branch with no PR (it filed
a ticket, or spiked), `overbridge start <repo> <id>` re-binds it to the item instead, carrying the task
branch's commits and uncommitted work onto the item's branch; `--here` does the same from any clean claim. Once a workspace's PRs are open and nothing is uncommitted or unpushed, the top panel
shows a Cleanup button (a `task/` workspace with no PR and no commits shows it too); wiping a workspace is the user's call, so never run `overbridge rm` yourself. A workspace
also removes itself when the user exits its Claude with every repo clean and pushed.
Once every PR has merged and nothing is unsaved, overbridge removes the workspace after your turn ends.
Commit and push everything before then. Otherwise the workspace stays, marked "merged · unsaved work".

## Branch naming

New branches: short kebab-case with a type prefix, e.g. `feat/zellij-layout`,
`fix/guard-symlinks`. Ask if the user has a ticket/issue to reference.

## Done with a branch

```sh
overbridge release <repo>   # detaches the worktree in place and frees the claim
```

Release only when the user says the work is finished or abandoned. Uncommitted
changes stay in the worktree.
