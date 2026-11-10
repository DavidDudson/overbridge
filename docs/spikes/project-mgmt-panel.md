# Spike: project management panel in the orchestration section

Issue: [#108 Spike: project management panel in the orchestration section](https://github.com/DavidDudson/overbridge/issues/108).
Prototype: `src/pm/board.ts` (pure model and rules) and `test/pm-board.test.ts` (32 tests, including a determinism check).
Nothing here touches the network or writes to a board.

## Summary

**Go.** Every question has a workable answer with existing tools (`gh` with the `project` scope, `jira-cli`), the
ranking is a pure total order that is cheap to explain, and the panel reuses the sidebar's start flow. The one
piece that needs new plumbing is a `board()` method on `Provider`; everything else is pure code already written.

## Findings

### 1. Work list panel

A k9s-like list fits the existing pane model. `renderBoard` in `src/pm/board.ts` draws it with the same
`boxTop`/`boxRow`/`boxBottom` helpers as the sidebar and top panel, one row per open item, the cursor row inverse:

```
╭─ Board · 5 ready · 1 active · 4 blocked ─────────────────────────────────────────────────────╮
│   id pr sz title                                               stream        slot / waits on │
│ 🟢 10 p0 3 Engine: rules core                                       area:engine   unblocks 1 │
│ 🟢 31 p1 2 Importer: CSV                                            area:importer unblocks 0 │
│ 🟢 21 p2 2 Sheet: print view                                        area:sheet    unblocks 0 │
│ 🟢 41    1 Fix typo                                                 #41           unblocks 0 │
│ 🟢 42    1 Fix other typo                                           #42           unblocks 0 │
│ 🔵 20 p0 4 Sheet: layout                                      area:sheet    🔄 gh-pioneer-20 │
│ 🔴 11 p1 2 Engine: rune effects                          area:engine   blocked by 10 (ready) │
│ 🔴 12 p1 1 Engine: rune display                          area:engine   blocked by 11 (ready) │
│ 🔴 30 p1 5 Importer: PDF                                         area:importer label blocked │
│ 🔴 40    1 Legal page          #40           blocked by 999 (not on the board, assumed open) │
│                                                                                              │
╰─ ⏎ start in a slot · o open · r refresh · / filter · b blocked ──────────────────────────────╯
```

Each row shows readiness (🟢 ready, 🔵 active, 🔴 blocked), id, priority, size, title, workstream, then either the
workspace that holds the item (with its agent glyph, as the sidebar shows it) or why it waits. The row is built
from the facts the rules used, so the panel never shows a position it cannot justify.

**Start in a slot.** `⏎` on a ready row runs the same path the sidebar's `s` prompt does today: `runStart` spawns
`overbridge start <repo> <id>` as a child so the fetch does not freeze the pane, and the new tab opens with
`/start-item <id>`. The repo comes from the item's `repository` field (Projects v2) or the project key (Jira); when a
board spans repos the panel asks, as `parseStart` already does with `AskRepo`. A row whose item is already claimed
shows its workspace instead, and `⏎` switches to that tab (`visitTab`).

Rough edges in the sketch: the header's column widths are computed separately from the rows', so they drift when
the tail text is long; the real panel should lay out columns once. No filter or scroll yet.

**Where it lives.** A third orchestration tab, `@board`, beside `@root` in `ORCHESTRATION_TABS`, with the panel in
place of Claude (`orchestrationTabKdl` takes a pane command). It is pinned in the sidebar's Orchestration frame
like `@root`, and the removal guards (`isOrchestrationTab`) already cover any new entry in that list.

### 2. Board reading

**GitHub Projects v2: yes, through `gh`, no token to store.** The user's token already carries the `project` scope.
Two calls give everything the rules need:

- `gh project item-list <n> --owner <o> --format json` returns each item with its custom fields flattened
  (`status`, `priority`, `size`, `area`, `order`, `labels`, `milestone`, `repository`, `content.number`). Checked
  against the Pioneer board (project 2, 595 items, 17 fields): Status is a single-select
  `Backlog | Ready | In progress | In review | Done`, Priority `p0 | p1 | p2`, Size `XS … XL`, Area a single-select,
  Order a number. That is exactly the `BoardItem` shape.
- `gh api graphql` on `issue.blockedBy` / `issue.blocking` gives the dependency edges. `gh issue list --json` does
  not expose them, so one GraphQL query per page of items (batched by ids) is needed.

Column names vary per board, so `normalizeStatus` maps a raw column to a `BoardStatus` through a config map first
(`project-management.board.status: { "Selected for Development": in-progress }`), then common names, and leaves
the rest `unknown` rather than guessing. An `unknown` row is visible, so a misconfigured board shows up.

**Jira: yes, through `jira-cli`.** `jira issue list --jql ... --raw` returns `fields.status.statusCategory`
(To Do / In Progress / Done), `priority`, `issuelinks` (the `is blocked by` links), `parent`, `labels`, `duedate`
and `customfield_*` for story points and rank. Status categories are the same three the rules need; the config map
handles custom columns. `jira` is not on this machine, so this part is read from the API shape, not run.

The provider change is one method, `board(): BoardItem[]`, beside `assigned()`. `WorkItem` stays as the subset
the rest of overbridge uses. A cache file beside `titles.json` keeps the last board so the panel draws before the
first refresh, as `cachedTitle` does for titles.

### 3. Parallel workstreams

**Yes, from two signals.** `streams()` is a union-find over open items: a `blockedBy` edge joins two items, and a
shared stream label (default prefix `area:`, configurable) joins all items that carry it. Each component is one
workstream, named by its label when it has one, else by its lowest id, so names hold across refreshes. Items in
different streams share no dependency and no area, so they can run in parallel without one waiting on, or
colliding with, the other.

What this does not catch: two items in the same files with no edge and no shared label. That needs a diff or a
model, and is out of scope; the rule set is honest about it by only claiming independence it can see.

### 4. Recommendation

**Yes, and it is a filter over the ranking, not a separate model.** `readiness()` gives each item a verdict with
the facts it rests on: done, active (in progress or in review), blocked (a `blocked` label, or an open blocker,
where a blocker the board did not return is assumed open), else ready. `recommend(ranked, freeSlots)` then takes
the top ready items, at most one per stream, and streams with nothing active first, so parallel slots land on
independent work. A stream that already has active work is offered only when nothing else is left, with a reason
saying it may collide. The free slot count comes from the limits the sidebar already reads.

Every recommendation carries `why`: the rank, the readiness facts, and the stream reason.

### 5. Deterministic prioritization

**Yes.** `RULES` is an ordered list; the first rule that tells two items apart decides, and the last rule is the id,
so no two items tie. The order is total, which `test/pm-board.test.ts` checks three ways: 200 seeded shuffles of
the fixture rank identically, two runs serialize byte for byte, and every pair of items is ordered with
antisymmetric comparison. No LLM, no clock, no network in the path.

| # | Rule | Key |
|---|------|-----|
| 1 | ready, then active, then blocked | readiness |
| 2 | priority, p0 first, unset last | `priority` |
| 3 | unblocks the most open items | count of open items with this id in `blockedBy` |
| 4 | due soonest, none last | `dueAt` |
| 5 | board order, unset last | `order` (Projects v2 number field, Jira rank) |
| 6 | smallest first, unsized last | `size` |
| 7 | oldest first | `createdAt` |
| 8 | id | natural sort |

`explain(a, b)` names the deciding rule with both sides' facts, which the panel can show on a keypress:

```
10 above 31: priority, p0 first, unset last (p0 vs p1)
11 above 12: unblocks the most open items (unblocks 1 vs unblocks 0)
12 above 30: board order, unset last (order 3 vs no board order)
```

Open question for the real thing: whether "unblocks" should outrank priority. The spike keeps priority first, since
that is what the board's owner set by hand.

## Design

```
overbridge.yml
  project-management:
    name: github            # or jira
    project: 2              # Projects v2 number, or owner/repo, or a Jira key
    board:                  # new, all optional
      status: { "Selected for Development": in-progress }
      blocked-labels: [blocked]
      stream-labels: [area:]

src/pm/provider.ts   Provider.board(): BoardItem[]       one new method
src/pm/github.ts     gh project item-list + graphql blockedBy
src/pm/jira.ts       jira issue list --raw, issuelinks
src/pm/board.ts      normalizeStatus, readiness, streams, rank, explain, recommend, renderBoard   (this spike)
src/pm/board-cache.ts last board per project, like titles.json
src/board-run.ts     tty loop: refresh in a child, cursor, ⏎ start, o open, / filter, b toggle blocked, ? explain
src/orchestration.ts ORCHESTRATION_TABS += { tab: "@board", label: "board" }
src/layout.ts        orchestrationTabKdl with the board pane instead of claude
```

Refresh runs `board()` in a child process on a timer and on `r`, writes the cache, and the pane re-reads it. The
pane itself never blocks on the network. Slots come from `readState()`: a claim whose branch's `idFromBranch`
matches an item marks that row with the workspace and its agent glyph.

## Recommendation

Proceed, in this order. Each is one PR.

1. **`Provider.board()` for GitHub Projects v2** with the status map and blocked-label config, plus the board
   cache. `src/pm/board.ts` and its tests land here as-is.
2. **The `@board` orchestration tab** with the list, cursor, refresh and `⏎ start in a slot` through `runStart`.
3. **Explain and recommend in the panel**: `?` on a row shows why it sits above its neighbour, and a `next` line
   at the top offers `recommend()` for the free slots.
4. **Jira `board()`** through `jira-cli` issuelinks and status categories.
5. **Later, if wanted:** filter and scroll, write-back of status on start (out of scope here), and a collision
   check between streams from the diff.

Not recommended: ranking with a model. The rule set already gives a defensible order with a reason per row, and a
model in the path would make the same board rank differently between refreshes.
