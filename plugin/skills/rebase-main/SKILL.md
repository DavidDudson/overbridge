---
name: rebase-main
description: Rebase the current branch onto the latest default branch (main), resolving conflicts per commit by intent, and finish with a lease-guarded force-push. Rewrites history, so use it only when the user wants a rebase or linear history. Use when the user says "rebase on main", "rebase this branch", or "I want linear history".
---

# Rebase onto main

Rewrites the branch's commits. Do not use it on a branch other people are building on without
agreeing it first. If the user has not asked for a rebase, use `merge-main`.

## Stacks first

If the branch is part of a `gh stack` (`gh stack view` shows a chain), do not hand-roll a rebase. A
plain `git rebase` of one mid-stack branch orphans every layer above it. Use:

```sh
gh stack sync       # fetch, drop merged layers, cascade-rebase the rest, retarget PRs
gh stack rebase     # rebase the whole stack on the latest default branch
gh stack push       # push every layer with a lease
```

Before any of those writes, line the lower layers up with origin. A stale local copy of a lower layer
gets force-pushed over origin and GitHub closes its PR. For each lower layer, `git fetch origin
<layer>` and compare it with `git rev-parse <layer> origin/<layer>`. If origin is ahead, update the
local layer first. Everything below is for a branch that is not in a stack.

## 1. Pre-flight

```sh
git status                          # clean tree; a rebase will not start otherwise
git branch --show-current           # not the default branch
ls .git/rebase-merge .git/rebase-apply 2>/dev/null   # a rebase already running: finish or abort it first
git config rerere.enabled true      # a conflict fixed in one commit is reused in later ones
git branch -f "$(git branch --show-current)-pre-rebase-backup" HEAD    # the way back if this goes wrong
```

In a worktree, `.git` is a file, so find the real directory with `git rev-parse --git-dir`.

## 2. Fetch and compare

Fetch the default branch on its own. A multi-ref fetch aborts if any ref is gone, which leaves
`origin/<default>` stale without saying so.

```sh
git fetch origin <default>
git log --oneline HEAD..origin/<default>     # new on the default branch; empty means already on top, so stop
git log --oneline origin/<default>..HEAD     # the commits that will be replayed
git merge-base HEAD origin/<default>         # the current base
```

### Branch built on a branch that already merged

If `origin/<default>..HEAD` lists commits you did not write, this branch was stacked on another one. If
that branch has since merged, especially by squash, the default branch holds its changes under
different SHAs. A plain rebase replays the stale originals on top of their merged copies and produces a
run of "already applied" conflicts.

```sh
git merge-base --is-ancestor <old-base-tip> origin/<default> && echo "plain rebase is fine" || echo "use --onto"
gh pr view <base-pr> --json state,mergedAt
```

`<old-base-tip>` is the parent of your first own commit in `origin/<default>..HEAD`. When it applies,
replay only your commits, after checking that `git log --oneline <old-base-tip>..HEAD` lists exactly
them:

```sh
git rebase --onto origin/<default> <old-base-tip>
```

## 3. Rebase

```sh
git rebase origin/<default>
```

It pauses at the first conflicting commit. You resolve it, run `git rebase --continue`, and it moves
to the next.

## 4. Resolve each stop

Each stop is a conflict between the default branch so far and the one commit being replayed. Resolve
for that commit's intent, not for the whole branch.

During a rebase `--ours` is the branch you are rebasing onto (the default branch) and `--theirs` is
your commit being replayed. This is the opposite of a merge. Check which is which before using either.

```sh
git status                          # shows the commit being applied
git rebase --show-current-patch     # that commit
git checkout --conflict=diff3 <path>    # markers with the base shown; this only rewrites the file
git log --oneline <merge-base>..origin/<default> -- <path>     # what the default branch did to the file
```

| Conflict | Usual resolution |
|---|---|
| Both modified | Combine both intents. If they truly clash, ask the user |
| Your commit deleted it, the default branch modified it | Keep the deletion, unless the other side added something the branch still needs: port it first |
| The default branch deleted it, your commit modified it | If it moved, apply your change at the new place. If removed on purpose, ask |
| Added by both | Merge into one, or keep both under distinct names |
| Lockfile or generated file | Do not hand-merge. Take the default branch's copy and regenerate it with the repo's command |

Stage each file, check for leftover markers with `rg -n '^(<<<<<<<|=======|>>>>>>>)' .`, then
`git rebase --continue`. If it turns messy or risky, run `git rebase --abort` and tell the user. The
backup ref from step 1 also restores the old tip.

## 5. Verify and push

Run the repo's checks on what changed (`overbridge config get commands.typecheck`, `commands.test`; an
unset one means the repo has none), each through `overbridge check <repo> -- <command>` (the check queue, which runs it in the repo's dev shell). Compare the result with the backup so nothing was lost:

```sh
git range-diff origin/<default>...<branch>-pre-rebase-backup origin/<default>...HEAD
```

Then push with a lease. The user asked for the rebase, so do not ask again; only stop if the lease is rejected (someone else pushed):

```sh
git push --force-with-lease
```

If it is rejected, someone pushed meanwhile. Fetch, look at what they added, and rebase again. Never
retry with a bare `--force`.

The push starts CI again. If the branch has a PR, watch it as `ship-pr` step 10 does (poll, read each
failure's log, fix what the rebase broke, push, watch again) and report any check that is not green.

Leave the backup ref in place and name it in the report, with `git branch -D "<branch>-pre-rebase-backup"` as the
line that removes it. Do not wait for the user to say they are happy.

## Rules

- Never resolve a conflict you do not understand. Ask.
- Never take one side wholesale without reading the other.
- Never force-push without a lease. The user asking for the rebase is the approval to push it.
- Report what you resolved, commit by commit, with anything you were unsure of called out.
