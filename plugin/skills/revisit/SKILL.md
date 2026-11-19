---
name: revisit
description: From the orchestrator (the overbridge root tab), find every workspace whose branch is ahead of the default branch (main) and ask that workspace's Claude to assess whether its commits are still relevant now that main has moved, and to continue the work if they are. Skips merged, iceboxed, detached and no-session workspaces, then prints a table of who was asked and who was skipped. Use when the user says "revisit", "revisit the workspaces", "are these branches still relevant", "check stale branches", "which branches are ahead of main", or invokes /revisit. Pass `--dry-run` to print the table without sending. Runs only in the orchestrator, never inside a workspace.
---

# Revisit

A branch that sits ahead of main for days may have been overtaken: main gained the same change, or the design
moved. This skill asks each such workspace's own Claude to judge, because it holds the context. The
orchestrator reads, picks and messages. It changes nothing itself.

## Where it runs

The orchestrator: `$OVERBRIDGE_TAB` is set and `$OVERBRIDGE_NAME` is empty. Inside a workspace the guard
blocks the other workspaces, so say so and stop. The orchestrator guard blocks shell loops, command
substitution and file redirects: one command per step, never try to work around it.

## Arguments

- `--dry-run`: build and print the table, send nothing.

## 1. Inventory

```sh
overbridge sync               # fetch every bare repo so origin/<default> is current
overbridge ahead --json       # live workspaces whose HEAD holds commits origin/<default> lacks
overbridge status --all --json # each workspace's agent: "agy" ones have no ListAgents session
```

Each row has `ws`, `repo`, `branch`, `session` (the Claude session name, equal to the workspace name), `ahead`,
`behind` (how far main has moved), `subjects` (newest first), `lastCommit`, `pr` (when recorded) and `dirty`.
Iceboxed workspaces, detached HEADs and branches with nothing ahead are not in it.

An agy workspace (`agent: "agy"` in `overbridge status --all --json`) has no session in `ListAgents`: ask it in
step 3 with `overbridge send <ws> '<message>'` (single quotes: the orchestrator guard refuses a backtick inside double quotes; write a `'` in the message as `'\''`). You hear no reply, so mark it "asked (agy)" in the table.

Then `ListAgents`. Match each row's `session` to a row by exact name. A session started before sessions were
named may carry an auto name; if none matches, skip the workspace with "no session" and say
`overbridge tab <ws>` reopens it.

## 2. Skip what needs no assessment

One `gh pr list -R OWNER/REPO --state merged --limit 100 --json number,headRefName,mergedAt` per repo
(`overbridge repo ls` gives the URL). Skip a row when:

| condition | reason |
| --- | --- |
| its branch is in the merged list | merged, the sweep removes it |
| no matching session (Claude workspaces only; an agy workspace is asked in step 3) | no session |
| `behind` is 0 and the branch has an open PR | up to date with main, still in review |

Everything else is asked: a branch with no PR, or one that main has moved past (`behind > 0`).

## 3. Ask

With `--dry-run`, go to step 4. Otherwise one `SendMessage` per workspace, to its `session`, with
`notify_when_idle: true`. A `busy` session queues the message until its turn ends. An agy workspace gets the
same text through `overbridge send <ws> '<message>'`, with no `notify_when_idle`; mark it `asked (agy)`.

```
Revisit <branch> in <ws>. It is <ahead> commit(s) ahead of <default> and <behind> behind.
Commits: <subjects, one per line>

Assess whether these commits are still relevant to <default> as it is now: has main gained the same change,
replaced the approach, or made the item moot? Answer in two lines, `relevant` or `obsolete`, then why.
If relevant, continue the work from where you are (merge or rebase on <default> per the repo's practice, finish
what the handoff or your plan left, ship it). If obsolete, change nothing and say what makes it so.
Don't delete the branch, close the PR or release the workspace: the user decides that.
```

Never tell a session to close, merge, force-push or delete anything: the workspace's own guard denies those
and the session stalls on the refusal.

## 4. Report

One table, in `overbridge ahead` order:

```
| ws | branch | ahead/behind | pr | action | reason |
| --- | --- | --- | --- | --- | --- |
| m4-conditions | feat/m4 | 3/12 | – | asked | main moved past it |
| ws5 | feat/x | 1/0 | #41 | skipped | up to date, in review |
| ws7 | fix/y | 2/4 | – | skipped | no session (overbridge tab ws7) |
```

`action` is `asked`, `asked (agy)`, `skipped` or `dry-run`. When sessions report back (the `notify_when_idle` reply), add a
line each: `relevant, continuing` or `obsolete: <their reason>`. List the obsolete ones last and offer to
remove them with the `cleanup` skill. Never remove one yourself.

## Rules

- Read-only: no `overbridge rm`, `release`, `checkout`, `gh pr close` or git write.
- One `gh pr list` per repo. Don't message a session twice in one run, and never the orchestrator itself.
- Don't ask a workspace that is merged or has nothing ahead: a session told to assess nothing spends its
  context deciding that.
