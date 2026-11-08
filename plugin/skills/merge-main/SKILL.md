---
name: merge-main
description: Merge the latest default branch (main) into the current branch and resolve conflicts by what both sides intended, not by picking a side. Keeps history, adds one merge commit, never force-pushes. Use when the user says "merge main", "update from main", "this branch is behind", or a PR shows conflicts and they want history kept.
---

# Merge main into the branch

Prefer this over `rebase-main` unless the user asks for linear history. It never rewrites commits, so it
is safe on a branch other people are building on.

On a `gh stack`, do not use this: run `gh stack sync` (or `gh stack rebase`) instead. Merging into one
layer leaves the layers above it behind.

## 1. Pre-flight

```sh
git status                      # clean tree, or finish the merge already in progress
git branch --show-current       # not the default branch
git remote show origin | rg 'HEAD branch'     # the default branch name, if unsure
git config rerere.enabled true  # reuse a resolution if the same conflict recurs
```

## 2. Fetch and look

Fetch the default branch on its own. A multi-ref fetch aborts if any ref is missing (a branch deleted
after its PR merged), and leaves `origin/<default>` stale without saying so.

```sh
git fetch origin <default>
git log --oneline HEAD..origin/<default>        # what is new there; empty means nothing to do
git log --oneline origin/<default>..HEAD        # what this branch adds
```

## 3. Merge

```sh
git merge origin/<default>
```

Clean merge: go to step 5.

## 4. Resolve conflicts by intent

```sh
git status | rg -i 'unmerged|both modified|deleted by|added by'
git checkout --conflict=diff3 <path>            # show the base alongside both sides
```

Never use `git checkout <branch>` to move between branches here. The `--conflict` form above only
rewrites a file's markers.

For each file, understand both sides before editing:

```sh
git log --oneline $(git merge-base HEAD origin/<default>)..origin/<default> -- <path>   # what the default branch did
git diff  $(git merge-base HEAD origin/<default>) origin/<default> -- <path>
git diff  $(git merge-base HEAD origin/<default>) HEAD -- <path>                         # what this branch did
```

During a merge `--ours` is this branch and `--theirs` is the default branch. Keep both intents where
they are compatible, and take the dominant one where they are not.

| Conflict | Usual resolution |
|---|---|
| Both modified | Combine both changes. If they truly clash, ask the user which behaviour wins |
| Deleted here, modified there | Keep the deletion, unless the other side added something this branch still needs: port it first |
| Deleted there, modified here | If the file moved or was replaced, apply this branch's change to the new place. If it was removed on purpose, ask |
| Added by both | Compare them; merge into one, or keep both under distinct names |
| Lockfile or generated file | Do not hand-merge. Take the default branch's copy, then regenerate it with the repo's own command |
| Renamed on one side | Follow the rename and apply the other side's edit there |

Stage each file as you finish it. Search for leftover markers before committing:

```sh
rg -n '^(<<<<<<<|=======|>>>>>>>)' .
```

## 5. Verify, commit, push

Run the repo's own checks on what changed:

```sh
overbridge config get commands.typecheck
overbridge config get commands.test
```

An unset command means the repo has none. Complete the merge with `git commit` (the default merge
message is fine, with no AI attribution), then push with a plain `git push`. If the push is rejected,
fetch and merge again: do not force.

Then confirm the PR is mergeable:

```sh
gh pr view --json mergeable,mergeStateStatus --jq '"mergeable: \(.mergeable)  state: \(.mergeStateStatus)"'
```

`BLOCKED` with no conflicts is only CI or approvals gating.

The push starts CI again. If the branch has a PR, watch it as `ship-pr` step 10 does (poll, read each
failure's log, fix what the merge broke, push, watch again) and report any check that is not green.

## Rules

- Never resolve a conflict you do not understand. Ask.
- Never take one side wholesale without reading the other.
- Never force-push from this skill.
- Report what you resolved and how, file by file, with anything you were unsure of called out.
