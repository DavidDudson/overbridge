# Spike: one long-running Bun server for refreshes and shared caching

Epic: [#157 epic: single long-running bun server for refreshes and shared caching](https://github.com/DavidDudson/overbridge/issues/157),
part of [#110 epic: performance with many workspaces open](https://github.com/DavidDudson/overbridge/issues/110).
Investigation only; the first implementation item is filed under the epic.

## Recommendation

**Go. Add `overbridge serve`: one Bun process per workspaces root that owns every network refresh and serves one cache.**
Keep panes reading the cache files they read today, so the server is a faster *writer*, not a new dependency for drawing.
A down server then costs only freshness, and the current subprocess path stays as the fallback.

Two things in the numbers shape the plan:

1. A refresh is dominated by `gh` round trips (0.5 to 0.8 s each, 3 per workspace), not by spawning `bun` (22 ms).
   The saving that matters is fewer and batched calls; killing the `bun` child is a small win that comes with it.
2. Per-PR data is unique per workspace, so a plain shared cache removes duplicate *triggers* (three uncoordinated ones
   today), not duplicate *keys*. The big cut needs batching: one GraphQL call per repo for every claimed PR (item 2).

## Current subprocess and polling map

Each row is a periodic or event-driven source of work. "Cost" is what one firing starts.

| Source | Where | Cadence | Cost per firing |
| --- | --- | --- | --- |
| Top panel refresh | `src/top-run.ts` `refresh()` | on start, every 60 s while its tab is focused, on `r`, after a PR action | spawns `bun cli.ts top refresh --ws <ws>` |
| Agent hook refresh | `src/agent-hook.ts` `claimRefresh`/`startRefresh` | every tool call; fires when the cache is over 60 s old and no refresh started in 30 s | spawns the same `top refresh` (detached), from every workspace, hidden or not |
| Merged-PR sweep | `src/sweep-trigger.ts`, `src/merge-sweep.ts` | every 60 s, one sidebar wins `claimSweep` | spawns `bun cli.ts top sweep`; that runs `refreshTop` in-process for each workspace whose cache is 60 s old or more |
| `refreshTop` (all three above) | `src/top.ts` | see above | per workspace: `gh issue view` (title), `gh pr view` (checks, reviews, comments), `gh api graphql` (review threads), one `sh -c` per `status` button; reads the gh-stack catalog from disk |
| Worklist refresh | `src/worklist-run.ts` | every 60 s from the `@work` pane | spawns `bun cli.ts worklist refresh`; per GitHub repo `gh api user` + `gh api graphql`, per Jira project `jira issue list` |
| Sidebar poll | `src/sidebar.ts` | 1 s focused tab, 30 s hidden (`HIDDEN_POLL_MS`), plus a state file watch | file reads; `git status`/`rev-list` for ended workspaces (memoised 10 s, `GIT_RECHECK_MS`); no network |
| Shared zellij view | `src/zellij-view.ts` | 1 s, one pane wins a lock | one `zellij action` call per second for the whole session |
| Check queue | `src/check-queue.ts` | each waiting ticket polls every 1 s (`TURN_POLL_MS`); load sampled up to every 15 s | file reads and `/proc` or `ps`; the check itself is a process group owned by its caller |
| Cleanup scan | `src/cleanup-gather.ts` | on demand (`overbridge cleanup`) | `gh pr view`, `gh pr list`, `gh api` per workspace, no cache |
| Auto-remove reaper | `src/auto-remove.ts` | each sidebar poll, git check memoised 10 s | local git only |

Per-workspace network cost of one `refreshTop`, with one repo, a claimed PR and a GitHub item:

| Call | Median latency | Notes |
| --- | --- | --- |
| `gh issue view` (title) | 545 ms | same item title is fetched again every refresh; the title cache only stores the result |
| `gh pr view --json ...rollup,reviews,comments` | 767 ms | |
| `gh api graphql` (review threads) | about 700 ms | separate query from the PR view |
| `bun cli.ts` child start | 22 ms | negligible next to the three above |

Three things are wrong with this shape, in order of cost:

- **No coordination.** The panel, the hook and the sweep each decide for themselves that a workspace is stale. Only the
  hook and sweep check cache age; the panel refreshes every 60 s regardless. Worst case is three refreshes of one
  workspace inside a minute.
- **N times the calls.** Calls grow linearly with workspaces, and all are GraphQL (about 1 point each, measured below).
- **Immutable data refetched.** An item title changes rarely, yet it is fetched every refresh for every workspace.

## Measured cost, before

Measured on this machine (28 cores, NixOS, Bun 1.4.4, `gh` 2.x, logged in; GitHub from a home network). Medians of 5 to 10
runs. Scripts were throwaway; the numbers below are the result, not a harness (the epic's benchmark item owns a harness).

Primitives:

| Operation | Median |
| --- | --- |
| `bun src/cli.ts <cmd>` cold start, `main.ts` loaded | 22 ms |
| `git status --porcelain`, `git rev-list --count HEAD --not --remotes` | 2 ms each |
| `gh pr view 142 --json ...` | 767 ms |
| `gh issue view --json title` | 545 ms |
| GraphQL, 1 PR with rollup, reviews, comments, threads in one call | 697 ms |
| GraphQL, 5 PRs in one aliased call | 937 ms |
| GraphQL, 10 PRs in one aliased call | 859 ms |
| 10 PRs one by one with `gh pr view` (what one workspace each costs today, minus threads) | 8,025 ms total |

Rate budget: `gh api rateLimit` before and after 10 `gh pr view`, 10 thread queries and 5 `gh issue view` shows about
1 GraphQL point per call (12, 13 and 8 points; the probe and other traffic add noise). GitHub allows 5,000 points per hour per user.

Today's shape, from `ps` on the running session: 5 workspaces plus `@root` and `@work`, each workspace with a `sidebar`,
a `top` and a `claude` wrapper Bun process at 41 to 59 MB RSS. Those pane processes stay under this design; only
refresh children and per-trigger `gh` fan-out go.

Modelled steady state, workspaces with a claimed PR, 60 s windows, one refresh per workspace per window:

| Workspaces | Processes started / min (1 bun + 3 gh each) | `gh` calls / min | GraphQL points / hour |
| --- | --- | --- | --- |
| 5 (today) | 20 | 15 | 900 |
| 10 | 40 | 30 | 1,800 |
| 28 (the zellij spike's shape) | 112 | 84 | 5,040, over the 5,000 limit |

Worst case with all three triggers firing on one workspace per window triples that. This is a model from the measured
primitives, not a measurement of a 28-workspace session.

## Proposed server

### Lifecycle

- `overbridge serve`: one per `OVERBRIDGE_ROOT`. Listens on `<meta>/server.sock`, mode 0600, pid in `<meta>/server.pid`.
  If that path is over the 104-byte unix socket limit, use `$XDG_RUNTIME_DIR/overbridge-<hash of root>.sock`.
- **Started lazily** by any client that cannot connect (`ensureServer`): take `<meta>/server.lock` with `O_EXCL`
  (stale when its pid is dead), spawn `serve` detached, wait up to 2 s for the socket. `spinup` also starts it.
  `bind` failing with `EADDRINUSE` means another server won; the loser exits.
- **Version handshake.** Clients send `version()` (`src/version.ts`). On a mismatch the server finishes in-flight
  fetches and exits; the next call starts the new one. A nix upgrade needs no manual restart.
- **Idle exit** after 10 minutes with no request and no `/events` subscriber, so a closed session leaves nothing behind.
- State in the server is cache only. Anything durable stays in `state.json` through `withState()`. A crash, kill or
  upgrade loses nothing that is not refetched in one window.
- The agents cannot reach it: the guard already denies workspace Claudes the `.overbridge` directory, and the socket is 0600.

### Transport

HTTP over the unix socket, `Bun.serve({ unix })`. Reasons: `fetch` on the client side, debuggable with
`curl --unix-socket`, no framing code, and SSE for push later (item 6) with no second transport. JSON bodies.

| Route | Purpose |
| --- | --- |
| `POST /refresh/top/<ws>` | refresh that workspace's top cache now (single-flighted); `?force=1` for the `r` key |
| `POST /refresh/worklist` | refresh the work list |
| `POST /sweep` | run the merged-PR sweep (the server also runs it on its own timer from item 5) |
| `GET /v/<key>` | read one cache key, stale-while-revalidate |
| `POST /invalidate` | `{keys: [...]}` or `{prefix: "gh:pr:"}` |
| `GET /status` | hits, misses, in-flight, last error per key, version, uptime (`overbridge server status`) |
| `GET /events` | SSE of changed keys (item 6) |

The hook must stay light (it runs on every tool call, and `CLAUDE.md` limits its imports), so its client is `node:net`
only: one `POST /refresh/top/<ws>` and exit, no response awaited. The 60 s and 30 s file locks in `agent-hook.ts`
become the server's job.

### Cache

An in-memory map `key -> {value, at, expires, error?}` with these rules:

- **Single flight.** Concurrent callers for one key share one promise, so a key is fetched once per window however
  many workspaces ask.
- **Stale while revalidate.** A hit past TTL but under the stale limit is returned at once and refetched in the
  background. Panes never wait on the network.
- **Errors are cached** for 15 s, then back off (15 s, 30 s, ... 5 min) per key. A failed fetch keeps the last good
  value (what `refreshTop` does today, "never go blank on an outage").
- **Global limits:** at most 4 `gh`/`jira` subprocesses in flight. A rate-limit reply (403 or `RATE_LIMITED`) pauses
  all `gh` keys until the reset time and shows in `/status`.
- **Coalescing window** of 250 ms for keys that batch (item 2), so workspaces refreshing together become one call.
- LRU cap of 2,000 entries; values are small.
- **Do not cache cheap local calls.** `git status` costs 2 ms; a socket hop costs more. Sidebar git checks stay in the pane.

| Key | Source | TTL | Stale limit | Notes |
| --- | --- | --- | --- | --- |
| `top:<ws>` | `refreshTop` result, also written to `top/<ws>.json` | 60 s | 10 min | phase 1 unit of work; after item 2 built from the keys below |
| `gh:pr:<owner/repo>#<n>` | PR view + threads + checks | 60 s | 10 min | batched per repo from item 2 |
| `gh:prs:<owner/repo>` | one aliased GraphQL for every claimed PR | 60 s | 10 min | fills the per-PR keys |
| `item:<provider>:<project>:<id>` | title | 10 min | 24 h | replaces `titles.json` writes |
| `gh:user` | `gh api user` | 1 h | forever | |
| `gh:repo:<owner/repo>:merge-settings` | merge flags used by Merge | 1 h | 24 h | |
| `board:gh:<owner/repo>` | worklist board query | 60 s | 10 min | |
| `board:jira:<project>:<jql hash>` | `jira issue list` | 60 s | 10 min | |
| `button:<ws>:<repo>:<id>` | button `status` command | 60 s | 10 min | runs in the repo's dev shell, as today |
| `git:fetch:<repo>` | bare repo `fetch` if added | 60 s | 10 min | not in scope until a pane needs it |

### Invalidation

- **Write-through on our own actions.** Ready/Draft, Merge, `overbridge pr`, `start`, `rm` and `release` call
  `POST /invalidate` for the keys they change. The top panel's after-action `refresh` becomes `?force=1`.
- **Agent signal.** A hook `Stop` event marks that workspace's `gh:pr` key dirty (an agent that just stopped has often
  just pushed), at most once per 10 s per workspace.
- **Force** (`r`) still single-flights and is rate-limited to once per 5 s per key.
- No webhooks: a home machine cannot receive them, and 60 s is the current contract.

### Failure modes

| Failure | Behaviour |
| --- | --- |
| Server never started or crashed | Clients get `ECONNREFUSED` in under 100 ms, attempt a start (at most once per 30 s through the lock), and run today's subprocess path for this call. Panes keep reading cache files. |
| Server hung (event loop blocked) | Client call times out at 2 s, falls back as above. A watchdog (`/status` miss twice) kills and restarts it. |
| `gh` or `jira` hangs | Per-call timeout 30 s, process group killed, key goes into error backoff. |
| `gh` not signed in / offline | Error cached with backoff; last good value served and `message` shown, as today. |
| Rate limited | All `gh` keys serve stale until reset; `/status` and the pane message say so. |
| Two servers race | `O_EXCL` lock plus `EADDRINUSE`; one exits. |
| Stale socket file after a crash | Connect fails, client unlinks it under the lock and starts a new server. |
| Version skew after an upgrade | Handshake mismatch makes the old server exit; clients fall back for that one call. |
| Cache or state file unparsable | Server writes atomically (tmp + rename), same as `writeTopCache`; readers already report instead of throwing. |

Fallback is the migration safety net, and the reason panes keep reading files: no pane code changes in phase 1.

### Not moving into the server

- **Check queue execution.** A check is a process group tied to its caller's terminal and `timeout`/CPU-stall kill. Running
  it in the server would make a server crash kill running checks. The *gate* (1 s polling per waiting ticket) could
  move later (item 8); the queue's file tickets keep working without a server.
- **Local git and agent state reads.** Cheaper than a socket call.
- **zellij view.** One call a second for the whole session; it disappears or changes with the multiplexer spike
  ([#107](https://github.com/DavidDudson/overbridge/issues/107)), not with this.

## Measured cost, after

Design estimate from the measured primitives, per 60 s window, 28 workspaces on 3 repos, one claimed PR each:

| | Today | Item 1 (server, one refresh per workspace per window) | Item 2 (batched per repo) | Items 2 + 3 (shared titles, user, settings) |
| --- | --- | --- | --- | --- |
| `bun` children started | 28 to 84 | 0 | 0 | 0 |
| `gh` calls | 84 to 252 | 84 | 3 to 4 | about 3 to 4 plus 2.8 titles |
| GraphQL points / hour | 5,040 to 15,000 | 5,040 | about 240 | about 400 |
| Wall time for the window's refresh | about 2 s each, parallel | about 2 s each, 4 in flight | about 0.9 s per repo | about 0.9 s per repo |

Item 1 alone does not cut calls below one per workspace; it removes the child processes and the duplicate triggers
(the 84 to 252 range collapses to 84). Item 2 is where the call count and the rate budget drop: 10 PRs cost 859 ms in one
call against 8,025 ms one by one. These "after" rows are modelled; each implementation PR must replace its column with a
measurement taken from `overbridge server status` counters (calls per key per window) and `procs` (child spawns).
Item 1's PR records the measured "after" for its own column.

## Follow-up items

Filed under [#157 epic: single long-running bun server for refreshes and shared caching](https://github.com/DavidDudson/overbridge/issues/157);
the epic body carries the checklist.

1. [#158 feat(server): overbridge serve, shared cache, top refresh through it](https://github.com/DavidDudson/overbridge/issues/158)
2. [#159 feat(server): batch PR reads into one GraphQL call per repo](https://github.com/DavidDudson/overbridge/issues/159)
3. [#160 feat(server): serve item titles, gh user and merge settings from the cache](https://github.com/DavidDudson/overbridge/issues/160)
4. [#161 feat(server): serve the worklist refresh from the server](https://github.com/DavidDudson/overbridge/issues/161)
5. [#162 feat(server): run the merged-PR sweep on a server timer](https://github.com/DavidDudson/overbridge/issues/162)
6. [#163 feat(server): SSE events so panes redraw on change](https://github.com/DavidDudson/overbridge/issues/163)
7. [#164 feat(server): server status, stop, restart and rate-limit backoff](https://github.com/DavidDudson/overbridge/issues/164)
8. [#165 chore(server): evaluate moving the check-queue gate into the server](https://github.com/DavidDudson/overbridge/issues/165): measured and not adopted, see [check-queue-gate.md](check-queue-gate.md)

## Open questions

- Does `gh` keep a connection pool across calls? No: each call pays TLS and auth. An in-process `fetch` with the token
  from `gh auth token` would cut each call from about 700 ms toward one round trip. That is a bigger change (token
  handling, GHES hosts, enterprise SSO) and is left out; revisit after item 2 measures what is left.
- Multiple roots on one machine: one server each, by socket path. Not exercised here.
