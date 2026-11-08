---
name: loop-item
description: Run a work item (GitHub issue or Jira ticket) end to end: start it, plan, implement, self-review, open the PR and get it to a green build. Pauses for plan approval before any code. Use when the user wants the whole lifecycle driven in one go ("loop 123", "run ENG-123 end to end", "take this issue through to a PR", "do the full process on this item").
---

# Loop an item

```
start-item (incl. scope gate) → [plan approval] → implement → commit → self-review → ship-pr → green build
```

This skill chains other skills and adds the glue. It does not redo their steps: invoke `start-item`
and `ship-pr` (and `mob-review` when the `overbridge-review` plugin is installed).

## Arguments

An item id (`123`, `#123`, `ENG-123`). Ask for it if missing.

## 1. Start

Run `start-item` with the id. It orients, scope-checks, claims the branch and ends in plan mode.
Its scope gate is a hard stop: on `SPLIT` or `CLARIFY`, wait for the user. If the item splits, this
loop runs the first slice only. The rest are separate runs, stacked with `gh stack add`.

## 2. Plan approval (STOP)

Do not auto-approve the plan. Wait for the user to accept it or change it. Code is expensive to
change and a plan is not.

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
  Run a single file or project before the whole suite. Do not run an expensive full suite without
  asking.
- If the work shows the plan was wrong, stop and re-confirm. Do not diverge quietly.

## 4. Commit, then self-review

Commit the change (Conventional Commits, `Refs <id>` in the body, no secrets) but do not push yet.
Review sees only committed work.

If the `mob-review` skill is available, run it on the branch against the default branch. It fixes
the small clear-cut findings on your own branch. Anything left at `change-requested` is a stop: fix
it now, or accept it with a stated reason, with the user. If `mob-review` is not installed, read your
own diff once for correctness, tests and leftovers before moving on.

## 5. Ship

Run `ship-pr`. Ask before creating the PR, as that skill does. Put `Closes <id>` in the PR body when
this PR finishes the item, and `Refs <id>` when it does not. Run the humanizer pass over the PR body.

## 6. Green build

```sh
gh pr checks --watch
```

Read each failure's log. Fix failures this branch caused, and rerun a flaky job once. Stop and report
when a failure is not from this branch or a second rerun fails. Do not loop on human review
comments: that is `resolve-feedback`, run on its own when the reviews land.

## Report

One line: item id, branch, PR URL, build status, and what the review left for the user.

## Rules

- Never skip the scope gate or the plan approval.
- Never push or open the PR before the self-review.
- Never switch branches with `git switch` or `git checkout`; use `overbridge checkout`.
- Write files and commands for the shell the user runs. Do not assume bash for anything you tell the
  user to run themselves.
