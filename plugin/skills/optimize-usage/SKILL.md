---
name: optimize-usage
description: Read the last 7 days of `overbridge history` and propose where to cut waste, whether that is trimming or merging skills, or speeding up individual Bash commands and checks. Use when the user says "optimize-usage", "optimise my usage", "what should I trim", "which skills are worth keeping", "which commands are slow", "speed up my bash commands", or asks for improvements from the @perf tab.
---

# Optimize usage

Read-only. It reads recorded history and proposes changes. It edits and files nothing unless asked. For slow repo checks in depth (queue wait, overlapping groups) hand off to `perf-recommend`.

## 1. Gather (7 days)

```sh
overbridge history --hours 168 --by total --json      # everything added up: tools, bash kinds, skills, checks, time split
overbridge history --hours 168 --by commands --json   # every Bash and check command: label, kind, count, ms, maxMs, failed, fulls
overbridge history --hours 168 --json                 # per workspace, to see where a pattern concentrates
```

Bash history keeps a command's leading words (`bun test`), never its arguments; check runs keep the whole line in `fulls`. Say the window you used. No history: say so and stop.

## 2. Skills

List what exists: `ls plugin/skills plugin-review/skills` in the overbridge checkout (or the repo's own skills folder) and `wc -w` each `SKILL.md`.

| Signal | Proposal |
| --- | --- |
| Invoked often (`skills` count) and long | `distill` it: every call loads the whole file. Saving is words × calls. |
| Invoked 0 times in 7 days | Candidate to remove, or to merge into a neighbour. Check the description is not why it never triggers before deleting. |
| Two skills always invoked together | Merge, or have one call the other. |
| Step in a skill that shells out to a slow command | Handled under Commands. |

Use `skills` from `--by total`. Rare but critical skills (incident, release) stay: say so rather than recommend removal.

## 3. Commands

From `--by commands`, rank by `ms` (total), then by `maxMs` (one bad run), then by `count` × mean (cheap but repeated).

| Signal | Proposal |
| --- | --- |
| Big total, `source` check | A cache, an affected-only run, or a faster subset locally; CI stays the full run. |
| Big `maxMs` against a small mean | An outlier: cold cache, network, a hung call. Find what differed before tuning. |
| Many runs, kind `git` or `other` | Batch into one call or one script; a `just` recipe if it is a fixed sequence. |
| Many runs of `test`/`lint`/`typecheck` through Bash | Should go through `overbridge check` (queued, timed, load-aware). |
| High `failed` | A failed run that was rerun doubled its cost; run the cheaper check first. |
| Label like `(other)` | Recorded before labels existed, or an unclassifiable command: ignore, do not guess. |

Also read `tools` and the time split from `--by total`: a Claude-time share dominated by `permission` means add allow rules for the repeated commands (`fewer-permission-prompts`); `user` is waiting on the person, not a fault.

## 4. Report

A table of at most seven proposals ranked by estimated time or words saved per week: **what**, **evidence** (counts and times from the JSON), **change** (one concrete step), **estimate** (say when it is a guess). Then one line on what you could not judge (too little data, no labels). Never propose skipping verification that CI runs. Offer to file the biggest as a tech-debt item (`loop-tech-debt`) or to run `distill` on named skills; do neither unasked.
