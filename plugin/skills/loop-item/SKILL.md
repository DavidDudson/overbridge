---
name: loop-item
description: Run a work item (GitHub issue or Jira ticket) end to end: start it, plan, implement, self-review, open the PR and get it to a green build. Runs without stopping, except when the scope gate says the item is too big or unclear. Use when the user wants the whole lifecycle driven in one go ("loop 123", "run ENG-123 end to end", "take this issue through to a PR", "do the full process on this item").
requires: gh-stack
---

# Loop an item

> Prerequisite: the `gh-stack` skill. Run `overbridge prereqs` first; if it fails, stop and tell the user to install it.

```
start-item (incl. scope gate) → plan → implement → commit → self-review → ship-pr → green build
```

This skill chains other skills and adds the glue. It does not redo their steps: invoke `start-item`
and `ship-pr` (and `mob-review` when the `overbridge-review` plugin is installed).

## Arguments

An item id (`123`, `#123`, `ENG-123`). Ask for it if missing.

## 1. Start

Run `start-item` with the id, in loop mode: it orients, scope-checks, claims the branch and writes the
plan as text, without entering plan mode or waiting for approval.
The scope gate is the one stop in this loop: on `SPLIT` or `CLARIFY`, wait for the user. If the item
splits, this loop runs the first slice only. The rest are separate runs, stacked with `gh stack add` in this
same workspace: never a new workspace for a layer.

Workspace: stay in the one you are in when the work is related (the affinity table in the `workspace` skill).
A `task/` claim with no PR re-binds to the item (`start-item` step 4); do not open a second workspace for it.

## 2. Plan (no stop)

The plan from step 1 is your own working order, not a gate. Go straight on to implementing. Keep it
for the PR body's summary, and for the check in step 3 that the work has not outgrown it.

## 3. Implement

- Follow the plan's order, riskiest first.
- Write tests as the plan's test approach says. If that changes while you work, tell the user.
- Match the surrounding code and the repo's `CLAUDE.md`.
- Check as you go with the repo's own commands, smallest scope first:
  ```sh
  overbridge config get commands.test        # unset: the repo has none, say so
  overbridge config get commands.typecheck
  overbridge config get commands.lint
  overbridge config get commands.format
  ```
  Run a single file or project before the whole suite; run the whole suite once at the end
  without asking.
  Run `test`, `typecheck` and `lint` through the check queue: `overbridge check <repo> -- <command>`. It runs one at a
  time across workspaces, in the repo's dev shell. Run `format` through `overbridge shell <repo> -- <command>`.
  Exit 124 means a check went over its time limit, 137 that it stopped using CPU, and 75 that it could not start in time: report
  it rather than retrying in a loop.
- If the work shows the plan was wrong, re-plan in place and carry on. Stop only when the item has
  outgrown its scope (it now touches work the scope check would have called a `SPLIT`): put that to the
  user and wait.

## 4. Commit, then self-review

Commit the change (Conventional Commits, `Refs <id>` in the body, no secrets) but do not push yet.
Review sees only committed work.

`ship-pr` runs `mob-review` on the open PR as a required step (unless `review.ship-pr` is `false`), so a pre-push panel run is optional here. If the `mob-review` skill is available and you want an early pass, run it on the branch against the default branch. It fixes
the small clear-cut findings on your own branch. Anything left at `change-requested` is a stop: fix
it now, or accept it with a stated reason, with the user. If `mob-review` is not installed, read your
own diff once for correctness, tests and leftovers before moving on.

## 5. Ship

Run `ship-pr`. It opens the PR without asking on a repo you own, and asks first on anyone else's. Put `Closes <id>` in the PR body when
this PR finishes the item, and `Refs <id>` when it does not. Run the humanizer pass over the PR body.

## 6. Green build

`ship-pr` step 10 does this; keep going until it ends. Poll the checks (never `gh pr checks --watch`, which
hangs on an approval gate), read every failure's log, fix what this branch caused, push, and watch
again. Rerun a flaky job (a 5xx while downloading a tool in a setup step is one) at most twice. Stop
and report when a failure is not from this branch or the rerun budget is spent, naming each check
that is not green. Every push after this (a review fix, a merge of main) starts the watch again. Do
not loop on human review comments: that is `resolve-feedback`, run on its own when the reviews land.

## Report

One line: item id, branch, PR URL, build status, and what the review left for the user. When the loop
spun off follow-up items, name them and say where each should run, per the `workspace` skill's table.

## Rules

- Never skip the scope gate. Apart from it, do not stop to ask: not for plan approval, for the PR, or for
  the build.
- Never push or open the PR before the self-review.
- Never switch branches with `git switch` or `git checkout`; use `overbridge checkout`.
- Write files and commands for the shell the user runs. Do not assume bash for anything you tell the
  user to run themselves.
