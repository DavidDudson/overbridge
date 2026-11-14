# Handoff format

One file per handoff, written by the session that is stopping and read by `read-handoff` in the next one.

**Where:** `$OVERBRIDGE_ROOT/<workspace>/.overbridge/handoffs/YYYYMMDD-HHMM-<first 8 chars of session id>.md`, where `<workspace>` is `overbridge whoami`. Create the directory if it is missing. The session id is `$OVERBRIDGE_SESSION` when set; otherwise use `manual`.

**Who writes one:**

- A session whose context is running low, once it has finished the task in hand (reason `context`). Overbridge ships no hook for this; write it when you notice, or when the user asks.
- Anyone, when the user asks for a handoff (reason `manual`).
- `overbridge icebox` writes one itself (reason `icebox`) when it pauses a workspace; `overbridge thaw` then starts the agent on `/read-handoff`.

Write for a reader who has none of this conversation. Give facts the reader can check, such as SHAs, paths, and commands, rather than an account of how the session went. Leave out any section with nothing in it.

```markdown
# Handoff: <item id or PR title> <goal in one line>

Next: <the first action, as a skill name or command, such as `ship-pr`>
Reason: context | manual | icebox
Workspace: <name>

## State

| Repo | Branch | HEAD | Uncommitted |
| --- | --- | --- | --- |
| app | feat/thing | abc1234 | none |

## Done

- <what is finished, with commit SHAs>

## In progress

- <half-done work, uncommitted files, and what they still need>

## Next steps

1. <ordered, concrete: the file, the command, the skill>

## Key files

- `path/to/file.ts`: <why it matters>

## Decisions

- <what was chosen and why, so the next session does not reopen it>

## Gotchas and dead ends

- <what was tried and failed, and anything surprising>

## Verify

- `<command that proves the current state, such as the targeted test run>`
```

The `Next:` line is what `read-handoff` acts on, so name a skill or a command, not a vague intent.

Refer to items, issues and PRs by title with their number, never by number alone.

After writing, tell the user the path and that `/clear` then `read-handoff` continues from it.
