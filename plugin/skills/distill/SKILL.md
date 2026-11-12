---
name: distill
description: Shorten skill and agent-instruction files without changing what they tell the agent to do. Use when the user says "distill", "tighten this skill", "cut tokens from these skills", or "this skill is too long", and names the files or skills.
---

# Distill

Make instruction files (`SKILL.md`, reference files, playbooks, `CLAUDE.md`, and `AGENTS.md`) shorter. Every rule, number, command, and name stays. Only the text that carries them gets shorter. A change in behaviour is a bug in the distill.

Take the target from the argument: file paths, skill names, or a plugin directory. With no target, ask for one.

## 1. Measure

```sh
wc -c -w <files>
```

Keep the numbers for the report. Then copy each target into a new temporary directory (`mktemp -d`) before you edit it. Step 5 compares against these copies, so changes the user made earlier are not mistaken for yours, and an untracked file can still be checked.

## 2. Find what repeats across files

Do this before touching prose, because it saves the most.

- **A block repeated across sibling files** (the same scope paragraph in every persona, the same spawn parameters in every step). State it once, in a preamble or in one reference file that each sibling names. Put it in the orchestrator's spawn prompt only when no sibling can run without that orchestrator, because a sibling run on its own would lose the rule without an error. Find candidates with `rg -c '<a distinctive phrase>' <dir>`.
- **A mode most runs skip** (a stacked-PR path, a split path, or a long template). Move it to a file beside `SKILL.md` and leave one line that says when to read it.
- **A table that copies facts another file owns.** Keep the owner's copy and point at it, unless the reader needs the facts before it can open that file.

Show the user these moves and wait for a yes before making them. They change which files exist, and other skills or tools may read the old ones. The prose moves in step 3 need no approval.

## 3. Shorten the prose

| Move | Before | After |
|---|---|---|
| Turn a short process list into a sentence | A "Process" heading over two numbered steps | "Scan for the patterns below, then rewrite." |
| Flatten sub-headings | **Why**, **Pattern**, **Boundaries**, and **Tests** blocks under one rule | Flat bullets, with each test question joined to its rule |
| Cut motivation that changes no decision | "The type checker is a proof assistant." | Deleted |
| Put the fix beside the item | "Substrate" in a list, then "Substrate becomes base" later | "Substrate (base)" |
| Merge sentences that share a subject | "Read every candidate. Score each one. Compare with the judge." | "Read every candidate, score each, and compare with the judge." |
| Collect record-keeping | "Record X" at the end of each phase | One Outputs line that lists what the record holds |
| Shorten output placeholders | "[Findings that should be addressed. For each: …]" | "[Each: …]" |
| Cut the announcement | "Present the verdict in this structure:" above the structure | Deleted |

Shorten the frontmatter `description` too. It loads in every session, so it costs more per character than the body. Keep what the skill does in one clause and the phrases that trigger it. Cut the list of what is inside the skill. For a skill with `disable-model-invocation: true`, one sentence is enough.

## 4. What stays

- Numbers, thresholds, commands, flags, paths, model names, and fallbacks, exactly as written.
- Fenced code blocks. Don't edit them.
- Stable ids that other files cite: rule numbers, step numbers, phase names, and heading text used as a link target. If you must renumber, fix every citation (`rg '<skill name>' <plugin dirs>`).
- An example that is the only statement of a rule, or that shows a case the rule text cannot.
- A reason, when the agent needs it to judge a case the rule does not name. Keep it to one clause.
- Whole sentences. Keep articles and verbs. Don't replace words with arrows, symbols, or abbreviations. Compressed text makes the agent guess at the missing words.

Leave a file alone when it would lose less than about 3% of its bytes. The diff costs the reviewer more than the saving is worth.

If the text contradicts itself, names something that does not exist, or asks for the wrong thing, don't fix it silently. List it in the report. Fix it in the same change only when the right answer is not in doubt, and say that you did. This is the one case where a distill changes a name, a command, or what a step asks for.

## 5. Check nothing was lost

1. Run `diff <copy> <file>` for each file against its step 1 copy. For every deleted line, name where its instruction now lives, or why it held none. Restore any line you cannot account for.
2. Resolve every file path, skill name, step number, and heading link in the changed files, and every citation of them from other files.
3. Run the repo's own checks for skills and plugins if it has any.
4. For a skill with output you can compare (a review panel, a report, or a verdict), offer to run it on the same input before and after. Don't run it unasked. It can cost more than the distill saved.

## 6. Report

Print a table with a row per file (bytes before, bytes after, change as a percentage) and a total row. Below it, list the step 2 moves made or declined, the files left alone, and the defects found. Don't commit.
