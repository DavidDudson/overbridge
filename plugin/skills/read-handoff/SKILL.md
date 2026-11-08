---
name: read-handoff
description: Fetch the latest handoff file for this overbridge workspace, check the checkouts still match it, and continue from its Next line. Pairs with /clear, so a long session can restart cheaply. Use when the user says "read-handoff", "read the handoff", "pick up from the handoff", "continue from where we left off", "resume the last session", or runs /clear then asks to carry on. Pass `--list` to see recent handoffs. Also use to write one when the user asks for a handoff.
---

# Read Handoff

A handoff is a markdown file the previous session wrote before it was cleared: what is done, what is half done, and what comes next. This skill finds the newest one, checks it against the checkouts, and continues. The format, and who writes handoffs, is in `HANDOFF-FORMAT.md` beside this file; read it too when the user asks you to write a handoff.

## Step 1: Find the handoff directory

Accept an optional argument: `--list`.

The directory is `$OVERBRIDGE_ROOT/<workspace>/.overbridge/handoffs/`. The workspace is `overbridge whoami` (it follows `$OVERBRIDGE_NAME`, then cwd). It sits beside the repo worktrees, outside every repo, so nothing in it can be committed.

Handoffs are per workspace. The guard blocks other workspaces, so never read or act on another workspace's handoff.

## Step 2: Pick the newest file

```sh
ls -t <handoff dir>/*.md
```

Take the first. With `--list`, show the five newest instead (name, modified time, `Next:` line, and whether a `.picked-up` marker sits beside it), then stop.

If there is none, say so and stop. Don't rebuild the context from git history unprompted. Offer `pickup` or `overbridge status` instead.

If the newest file is more than a working day old, or already has a `.picked-up` marker, say so and ask before continuing from it.

## Step 3: Read it and check for drift

Read the whole file. Then check its `## State` table against `overbridge status` and each repo:

```sh
git -C <repo> rev-parse --abbrev-ref HEAD
git -C <repo> rev-parse --short HEAD
git -C <repo> status -s
git -C <repo> merge-base --is-ancestor <recorded SHA> HEAD && echo descendant
```

- **Matches** → carry on.
- **Moved forward** (the ancestry check prints `descendant`, because someone pushed or merged the default branch) → mention it and carry on.
- **Different branch, missing commit, a claim the workspace no longer holds, or uncommitted changes the handoff doesn't list** → stop and show the user the difference. Don't continue on a checkout the handoff doesn't describe. To get back on a branch, use `overbridge checkout <repo> <branch>`; never `git switch`.

## Step 4: Mark it picked up

```sh
touch <handoff>.md.picked-up
```

This stops `--list` from offering the same handoff as unread.

## Step 5: Summarise and continue

Give the user a short summary: item, branch, what is done, and the `Next:` line. Then do the `Next:` action:

- A skill (`mob-review`, `ship-pr`, `resolve-feedback`, …) → invoke it.
- A command or a numbered next step → do it.
- A question for the user, or anything that needs a decision the handoff left open → ask it, then continue.

Treat **Decisions** as settled. Don't reopen them unless the checkout or the user contradicts them. Treat **Gotchas and dead ends** as already tried.

## Rules

- Read the handoff in full before acting. The `Next:` line alone misses the in-progress notes.
- Never act on another workspace's handoff.
- Never delete handoff files. They are the trail across sessions.
