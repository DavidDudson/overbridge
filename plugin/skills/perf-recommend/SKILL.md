---
name: perf-recommend
description: Read where each workspace's time went (`overbridge history`) and recommend where to get time back, ranked by hours saved: slow or often-repeated repo tools such as check, lint and test, check-queue wait, failed runs that were rerun, permission prompts, and waiting on the user. Use when the user says "perf-recommend", "where can we get time back", "what is slow", "how do I speed up my checks", "optimise the checks", or asks what the @perf tab shows.
---

# Recommend where to get time back

Read-only. It reads recorded history and proposes changes. It edits nothing and files nothing without being asked.

## 1. Gather

Use a window long enough to be typical (a week), and say which one you used.

```sh
overbridge history --by repo --hours 168 --json     # check runs per repo, with groups and full commands
overbridge history --hours 168 --json               # rows of {ws, summary}: Claude time split, tools, check groups
overbridge history --by repo --hours 24             # the same, for today only
```

`--by repo` is the lens that matters: repo tools (`check`, `lint`, `test`, `typecheck`, `build`) are what can be
optimised. Each group is the task a command ran (`just check` is `check`), and `fulls` holds the full command lines
behind it. Claude's own time (model, tools) comes from the per-workspace output, where each field sits under `summary` (`summary.permissionMs`); it cannot be attributed to a repo.

If there is no history, say so and stop: it fills as Claude and `overbridge check` run.

## 2. Find the time

Work out, per repo and per group, from the JSON (percentages are the share of that repo's check time):

| Signal | Where it shows | What it means |
| --- | --- | --- |
| Big share of run time | `ms` / repo `ms` | The first thing to optimise. A group at 50% or more of a repo's check time is the target. |
| Many runs | `count` | A cheap run repeated often costs as much as one slow run. Multiply `count` by the mean. |
| Queue wait | `queuedMs` against `ms` | Runs wait for a slot. Queue time near or over run time says the machine, `check-queue.max-parallel` or `max-load-percent` is the limit, not the tool. |
| Failures | `failed` against `count` | A failed run that was fixed and rerun doubled its cost. Many failures on one group: run the cheaper check first. |
| Overlapping groups | `fulls` of two groups | `check` that already runs `lint` and `test` makes separate `lint` and `test` runs duplicate work. |
| Permission prompts | per-workspace `summary.permissionMs` | Time waiting on an approval. Recommend an allow rule for the repeated command. |
| User wait | per-workspace `summary.userMs` | Claude idle while the user is away. Not a tool problem: name it, do not "fix" it. |

Look at the full command, not just the group: it tells you what to change (a missing cache, a whole-repo run where
an affected-only one exists, a serial run that could be parallel).

## 3. Recommend

Rank by estimated time back per week (runs × time saved per run). For each, give:

- **What:** the group and repo, with its share (`check 61.3% of app's 4h10m`).
- **Why it is slow:** one line from the signals above, quoting the full command.
- **Change:** one concrete step. Examples: split a slow check into a fast pre-push subset and a full CI one; run only
  the affected tests; cache the build (a missing remote or local cache shows as the same build running in every
  workspace); raise `check-queue.max-parallel` when queue wait dominates and the load allows; drop a group that another
  one already includes; add a permission rule for a command approved over and over.
- **Estimate:** time back per week, and how sure you are. Say when it is a guess.

Never recommend a change that skips verification in the repo's CI. Fast local checks are a subset, not a replacement.

## 4. Report

A short table, top five at most, then one line on what you did not look at (a repo with no check runs, a window with
too little data). Offer to file the biggest as a tech-debt item (`loop-tech-debt`); do not file it unasked.
