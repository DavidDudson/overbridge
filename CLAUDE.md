# overbridge

Bun + TypeScript CLI, no runtime deps. `just check` = typecheck + tests.

- `src/cli.ts` is a thin entry with no static imports; `src/main.ts` holds arg dispatch → `src/commands.ts`.
  `overbridge hook` (`src/agent-hook.ts`) runs on every tool call, so it is dispatched before `main.ts`
  loads; keep its imports to `paths.ts`, `agent-state.ts`, `bg-tasks.ts`, `proc.ts`, `server-net.ts`, `version.ts`, `json.ts`, `history.ts`, `agent-kind.ts`, `agy-hook.ts` (both import only `json.ts`) and node builtins.
  Process lookups go through `src/proc.ts` (`/proc` on Linux, `ps` on macOS); never read `/proc` directly.
- Per-repo config: `src/project-config.ts` parses and validates `overbridge.yml` (`overbridge.schema.json` and
  `overbridge.example.yml` must track its keys). The root `config.yml` layers over it (`loadRootLayers`, `resolveConfig`:
  `defaults` < repo file < `repos.<name>`; `config.schema.json` describes it), and top-level `x-*` keys pass through
  for extensions. Load repo config through `loadRepoConfig`/`loadConfigFile` so the layers apply.
  Lifecycle hooks (`src/hooks.ts`, `runHooks`) come only from the root `config.yml`; `validateConfig` rejects them
  in a repo file. Call `runHooks` outside `withState` so a hook can run overbridge. Top panel `buttons` are
  root-only too (`validateConfig`'s `root` option): `refreshTop` runs their `status` into `TopCache.buttons`, reusing it while the PR view is unchanged (`refreshButtons`, `TopCache.buttonRuns`, `BUTTON_MAX_AGE_MS`; a forced refresh always runs) and never running it while `gh` is paused; buttons get the path of a file holding that view (`prViewFile`) as `OVERBRIDGE_PR_JSON` (empty with no PR view); a forced refresh reads PRs through a rate-limit pause but buttons still wait (`buttonsPaused`).
  Global config is `repos.toml` (`src/config.ts`, e.g. `[sidebar] width`).
  Keep code generic: no repo names, ports, URLs or branch conventions outside that config.
  This repo dogfoods its own `overbridge.yml` (checked by `test/config-errors.test.ts`).
- `src/server.ts` is `overbridge serve`: one Bun process per root (`<meta>/server.sock`, `server.pid` doubles as the single-instance lock),
  HTTP over the unix socket. `POST /refresh/top/<ws>` (`?force=1`, `?async=1`) runs `refreshTop` in a worker (`src/server-worker.ts`)
  through `src/server-cache.ts` (pure, fake-clock tested: single flight, TTL from fetch start, stale-while-revalidate, error backoff,
  in-flight cap); `GET /status` shows its counters. A client of another version gets 409; the server also exits only when that client's build is newer (`OVERBRIDGE_BUILD_TIME`, the flake's commit time, sent as `x-overbridge-build`) when both sides have one, else when its release version is (`shouldReplace` in `src/version.ts`). Without a build time on both sides, a rev or dev version is never newer, so builds side by side (older panes, a dev checkout) cannot keep killing each other's server. The server also exits when an upgrade deleted its worker file (`workerFileGone`), on a request (503) and on the sweep timer.
  `OVERBRIDGE_NO_SERVER` disables every client. A forced get (`force`) is always a fetch that starts after the call.
  `src/server-net.ts` is the node-only client (the hook imports it: `call`, `notifyRefresh`, `startServer` throttled by `server.start`);
  `src/server-client.ts` is `serverRefresh` for the panel and sweep. A caller that gets `undefined` runs its old path, so keep every
  new caller falling back, and keep panes reading cache files. Tests that call a client pass `start: false` so none starts a real server.
- Work items: `src/pm/` (`Provider` interface, `github.ts`, `jira.ts`, title cache); `src/item.ts` is `overbridge item`.
  Providers and apps take injectable runners so tests never need `gh`, `jira` or real processes.
- Apps: `src/apps.ts` (launch, teardown, port pool, status) and `src/app-command.ts` (`overbridge app`).
- Panes: `src/top.ts` (pure model, layout, cache) + `src/top-run.ts` (tty loop); `src/sidebar.ts`; shared terminal
  helpers in `src/term.ts`; both panes read the multiplexer's tab order and focused tab through `src/zellij-view.ts`
  (`readView`: one shared file, refreshed by one pane per second), do their full poll only on the focused tab
  (`shouldPoll`, every `HIDDEN_POLL_MS` when hidden), and write a frame only when it changed (`createPainter`); the sidebar's bottom border shows `src/version.ts`'s version (package.json's when real,
  else `OVERBRIDGE_VERSION`, which the flake sets to the git rev, else `dev`), read once when the pane starts; `src/agent-state.ts` reads what `src/agent-hook.ts` writes; `src/panes.ts` is the terminal/diff/claude pane toggles and `overbridge diff`; `src/pr-actions.ts` is the top panel's Ready/Draft and Merge (PR or `gh stack`); `src/next.ts` picks the next tab needing attention; `src/go.ts` is `overbridge go` (tab by sidebar number, name, next/prev; `sessionExec` in `src/tab.ts` reaches the session by name from outside zellij); `src/limits.ts` reads the usage limits Claude's statusline writes. `src/gauge.ts` reads the per-card context gauge (`<meta>/context/<ws>.json`, statusline) and the selected card's last-turn receipt (`<meta>/agent/<ws>.turn.json`, kept by `recordTurn` in `src/agent-state.ts`) through `cachedRead`, an mtime cache. Pure parts are unit-tested.
  `src/card-look.ts` is the pure card look (elapsed-time tint, glyph pulse, title tone, PR state as `HealthInput`); it reuses `pr-look.ts`/`anim.ts`/`tab-badge.ts` from the PR tabs, so colours and icons mean the same everywhere.
- `src/shell.ts` resolves a repo's dev shell (`shell` key): prefix or cached env (`$XDG_CACHE_HOME/overbridge/shell`); used by `overbridge shell`, `claude()` (one repo: agent starts inside it, marker `<meta>/agent/<ws>.shell`), the terminal pane and the generated CLAUDE.md. Keep it tool-agnostic.
- `src/check-queue.ts` is `overbridge check`: tickets in `<meta>/check-queue/`, no lock. `gateFor` starts a ticket once every live
  ticket ahead is running, fewer than `max-parallel` are, and either none is running or the load allows (`unsettledLoad` counts runs the 1-minute
  average does not show yet); owners are looked up in one batch per poll (`splitLive`, `pidsAlive`), never one `ps` per ticket; then the command runs in its own process group, killed on `timeout-seconds` or a CPU stall
  (`groupCpuSeconds` in `src/proc.ts`). Its pure parts are unit-tested; `test/e2e.test.ts` drives the real queue.
  Tickets sort by `queueComparator`: the workspace's class rank (`src/workspace-class.ts` over `check-queue.priority` and
  `priority-rules`; classes are the root-only `priority-classes`, `src/check-priority.ts`), recorded in the ticket when
  queued, then queue time, unless `order.state` (written only by the `@checks` tab, `src/checks.ts` pure rows/render +
  `src/checks-run.ts` pane) holds an override key. The tab kills a check with `stopTicket` (the owner kills the group, records the run as killed and keeps its ticket until the group is gone; `stopChecksFor` awaits that) and
  its `v` view lists finished runs from history (`recentChecks`, `renderRecent`). `src/check-estimate.ts` keeps the last run times per repo and command (`<meta>/check-estimates.json`, written as each run ends) and simulates the queue into ETAs (`queueEtas`) for the tab, the sidebar and the wait message. A ticket with no `rank` is from an older build: `comparatorFor`
  then sorts everyone by time, as that build does. The caps in `gateFor` count every running ticket, not only those
  ahead. `refreshTop` stores the workspace class in `TopCache.priority`/`priorityIcon` for the sidebar card.
- CPU priority: `src/cpu-priority.ts` is the pure pass (`planPriority`): a process belongs to the workspace whose
  `OVERBRIDGE_NAME` it set (not inherited), descendants follow, and the multiplexer, its ancestors and the server are
  never touched, so they stay at nice 0 above every workspace. Each class has a `nice` (`classTargets` in `src/check-priority.ts`, 1 + 4 × rank
  by default) and, on macOS, `background` (`taskpolicy -b/-B`, reversible). Only root lowers a nice, so a class that
  rose leaves `stuck` processes, which the sidebar card shows. `src/cpu-priority-run.ts` runs it (`overbridge priority`,
  the server every `PRIORITY_PASS_MS`, the sidebar's sweep fallback) and writes `<meta>/cpu-priority.json`.
  A workspace with no class in its top cache yet gets no target, and the root `cpu-priority: false` stops every pass.
  Processes come from `listEnvProcs` in `src/proc.ts`. Never pass a workspace's `OVERBRIDGE_NAME` to the server.
- `src/mux.ts` is the only code that runs `zellij` or `tmux`: the `Mux` interface (tabs, panes, sessions) with `zellijMux` and
  `tmuxMux`, chosen by `defaultMux` (`$TMUX`, `$ZELLIJ`, then `OVERBRIDGE_MUX`, else zellij; outside a session zellij is reached
  by `--session`). Call sites take an injectable `Mux`; tests fake the exec with `zellijMux(fake)` or `tmuxMux(fake)`. tmux
  addresses windows by id or index, never by name: a name starting with `@` (an orchestration tab) reads as a window id even
  after `=`. Read tabs and panes through `-F` formats, never by parsing text. `src/tmux-layout.ts` renders a `TabSpec` as
  tmux commands (`tabOpen`, `tabFill`), the `overbridge layout` script and the server config.
- `src/layout.ts` describes each tab as data (`TabSpec`: `workspaceTabSpec`, `orchestrationTabSpec`, `layoutSpecs`) and renders
  zellij KDL from it (`specKdl`, `tabKdl`, `layoutKdl`); tmux renders the same specs. A zellij user `layouts/overbridge.kdl`
  replaces the generated KDL; tmux has no user layout.
- `src/orchestration.ts` lists the orchestration tabs (`@root`: Claude in the root). Their names start with `@` so they never
  match `NAME_RE`. The sidebar pins them in its Orchestration frame; their Claude gets the agent-state hooks, the orchestrator guard
  (`src/guard-orchestrator.ts`: an allow list, fail closed) and a brief (`orchestratorPrompt`) through `claude --settings`
  (`scaffoldOrchestration`); `OVERBRIDGE_TAB` with no `OVERBRIDGE_NAME` selects that guard.
  The brief routes a PR request to the workspace already claiming its head branch (`overbridge status --all`, then
  `SendMessage` `/pickup #<pr> ...` with `notify_when_idle`) and starts a workspace only when none holds it.
  They never go away: every removal path checks `isOrchestrationTab` (`removeWorkspace`, `cleanable`, `beginRemoval`, `verdictFor`; add it to any
  new one), `claudeOrchestration` restarts Claude when it exits (`restartAfter`), and the sidebar poll reopens a closed tab
  (`ensureOrchestrationTabs` in `src/orchestration-keep.ts`, one owner per tab through a reopen lock).
- `src/start.ts` is `overbridge start <repo> <id>` (or `--task <slug>` for work with no item, on `task/<slug>`, or `--stack <id>...`, bottom first:
  `startStack` claims the bottom branch, runs `gh stack init` for every layer, and leaves HEAD on layer 1; the catalog then makes the claim cover all
  layers, and a failed init is undone by `undoStack`; layers already on origin are refused): one workspace per work item, named by `Provider.workspaceName`,
  added to the running session with `openTab`. Cleanup (`cleanable`, `pressCleanup` in `src/top.ts`; `beginRemoval`, `finishRemoval` in `src/remove.ts`)
  offers to remove a workspace whose PRs are open with nothing uncommitted or unpushed. `beginRemoval` marks it `removing` in state
  (the sidebar hides it), switches to `landingTab` (`src/next.ts`), closes its tab by id, and starts a detached `rm --background-finish` worker.
  A failed worker sets `removeError` (shown on the sidebar card) and reopens the tab.
  A session the user exits on purpose (`endedForGood`, reason `prompt_input_exit`) also makes a workspace cleanable.
  Each sidebar's poll runs `createReaper` (`src/auto-remove.ts`), which calls `beginRemoval` with `Landing.IfFocused`
  once git is clean, or marks the card `ended · unsaved work`.
  Every sidebar card is its own failure domain: `entries` builds each card in a guard (`workspaceFault`, `readTopCacheChecked`),
  the reaper reports a throw per workspace (`ReapResult.faults`), and the pane's poll is `gather` over injectable `SidebarReaders`,
  keeping the last good `Model` and putting the first failure in the footer. The sidebar reads state through `tryReadState`;
  writers keep `readState`, so a file `withState` cannot parse is never overwritten. A reader that can be fed a bad file must
  report, not throw.
  A re-bind (`rebind` in `src/start.ts`) records `Claim.reboundFrom` (the old branch and PR; `overbridge status` shows it). `TopCache.branches`
  records the branches `merged` and `prsOpen` were built for, and `claimedCache` drops both once a claim has moved, so the sweep and Cleanup
  never act on the PR a workspace was re-bound away from.
  Once every claimed PR has merged (`TopCache.merged`, the PR head commits), `src/merge-sweep.ts` (`overbridge top sweep`) removes the workspace
  through `beginRemoval` with `Landing.IfFocused`, after `mergedClean` checks that each HEAD is its PR head. A squash merge
  leaves no remote branch holding those commits, so `hasUnpushed` cannot do that check. Unsaved work sets `removalBlocked`, which the sidebar card shows.
  The sidebar starts the sweep; `claimSweep` (`src/sweep-trigger.ts`) lets one sidebar run it per `MERGE_SWEEP_MS`.
  Every removal is visible: `beginRemoval` stores its `CleanupCause` in `removing`, `finishRemoval` appends the outcome to
  `State.cleanups` (`src/cleanup-log.ts`), and the sidebar shows a countdown to the next sweep, the removals in flight and those finished since the last sweep (`cleanupRows`).
- GitHub rate limit: every steady `gh` read is sized for 20+ sessions on one 5,000-point GraphQL budget.
  The `@prs`/`@reviews` lists (`src/prlist-refresh.ts`) run a one-point probe first (`src/prlist-probe.ts`) and read in full,
  sized to the probe's count, only when it changed or the rows are `FULL_MAX_AGE_MS` old; the panes refresh through the
  server (`POST /refresh/prlist/<kind>`, worker `src/server-prlist-worker.ts`) so the rate-limit pause applies, with a child as
  the fallback. The batcher keeps a repo's reply for `PR_SETTLED_TTL_MS` once every PR in it `isSettled` and each caller's
  local HEAD is its PR's head (`ttlFor`, heads from `prefetchFor`). `overbridge pr-checks` (`src/pr-checks.ts`, `GET /pr-checks`)
  serves an agent's CI poll from the batch; the skills poll with it, not `gh pr checks`. The mention scan skips a set of
  watched items whose update times have not changed (`mentionSignature`). Who `gh` is signed in as comes from `src/gh-login.ts`.
- Silenced items: `src/silence.ts` is the pure rule (`isSilenced` decides from the user's toggle, a team review's `seenAt`, and the newest mention) plus the `silenced.json`/`mentions.json` I/O.
  Only `toggleSilence` in `src/silence-refresh.ts` writes `silenced.json` (a pane's `x` or `overbridge silence toggle`), reading it with `readStoreForWrite` so a file it cannot parse is never overwritten.
  Only `refreshMentions` there writes `mentions.json` (`overbridge silence refresh`, and the claim `spawnMentionRefresh` takes first); `src/mention-scan.ts` builds the GraphQL query and parses the reply.
  `src/prlist-data.ts` holds the PR list caches so the scan reads them without loading the panes. The badges (`src/my-badges.ts`) leave silenced rows out.
- `src/icebox.ts` is `overbridge icebox`/`thaw`: a paused workspace keeps its claims and worktrees, has `iceboxed` in state and no
  tab. `icebox` refuses on `unsavedRepos`, stops apps (`stopApps`) and checks (`stopChecksFor`), writes a handoff (`src/handoff.ts`)
  and closes the tab last (`leaveTab`); `thaw` reopens it with `--continue` and `/read-handoff`. `entries()` leaves iceboxed
  workspaces out (they have no tab, so no digit; the sidebar lists them under `icedRows`), and `workspaceNames()` skips them for
  `up`/`layout`. Any new code that lists workspaces for tabs must skip `isIceboxed`.
  `f` in a sidebar runs `icebox` on its own workspace in a child (`runFreeze`); the `@frozen` tab (`src/frozen.ts` pure rows and
  render, `src/frozen-run.ts` pane) lists iceboxed workspaces from state and `t` runs `thaw` in a child (`runThaw`).
- `src/explore.ts` is the `@explore` tab (`overbridge explore`, pane in `src/explore-run.ts`): a repo picker, then the top
  panel (`topPanel` with `PanelOptions`: its own `TopScope`, only the terminal pane, a `back` button) over a detached
  checkout of the default branch at `<root>/@explore/<repo>`. `syncPlan` moves that checkout only while it is clean and on
  the default branch's history (untracked files do not block it); syncs are single-flight and run only while the tab is focused. App ports count `EXPLORE_TAB` (in `src/orchestration.ts`) as a holder (`holders` in `src/apps.ts`); leaving a repo stops its explore apps.
- `overbridge cleanup` reports what the sweep leaves behind and removes nothing: `src/cleanup-scan.ts` is the pure `classify`
  (facts → `CleanupVerdict` + `CleanupReason`; blockers turn a removal into a review, a failed read into `keep`),
  `src/cleanup-gather.ts` reads the facts through injectable `GatherDeps` (git, `gh`, `Provider.status`), and `src/orphan.ts`
  finds orphans (a folder state does not list that holds a registered worktree or `.claude`). `removeWorkspace` passes an
  orphan to `removeOrphan`. The `cleanup` skill keeps the judgement; keep its verdict table in sync with `CleanupReason`.
- `src/history.ts` is where each workspace's time goes: the agent hook (`recordHistory`) appends Claude events and `overbridge check` appends
  each run, to `<meta>/history/<ws>.jsonl` behind `HistoryStore` (the seam for the bun server the refresh spike proposes; `historyStore()` picks
  the implementation). It stores Claude's tool names and a command class, never prompt or Bash text; only `overbridge check` records keep a command line, through best-effort `redactCommand` (a secret passed as a bare positional argument is kept). `summarize` is the pure fold into turn/model/tool/
  permission/user time, and `summarizeRepos` the fold of check runs per repo (groups from `commandGroup`; check records keep the full command, blanked by `redactCommand`);
  `src/history-report.ts` formats it (`overbridge history`) and `src/perf-run.ts` is the `@perf` tab (`p` in the sidebar; `v` cycles dashboard/sessions/commands, `g` toggles workspace/repo in sessions) over the pure renderers in `src/perf-views.ts`. Claude Bash calls store `label` (`bashLabel`: program plus task/subcommand, no other words) and Skill calls the skill name; `perf.json` without a `dashboard` per window is stale and recomputed.
  `src/perf-cache.ts` computes every window x grouping into `<meta>/perf.json` (0600): the server writes it from a worker (`POST /refresh/perf`), the tab reads it while young and computes itself otherwise.
  Like the hook, `history.ts` imports node builtins, `paths.ts` and `json.ts` only.
- Agents: `src/agent-kind.ts` (`claude` | `agy`). A workspace's agent is chosen once, at creation (`overbridge start --agent`,
  else the root `config.yml`'s `agent`), and kept in `WorkspaceState.agent` (unset = Claude; read through `agentOf`).
  `src/agy.ts` holds what an agy workspace gets instead of Claude's settings: it starts in the workspace folder
  (`agentDir`), where `scaffold` writes `AGENTS.md`, `.agents/hooks.json` and `.agents/skills.json`, and its folder goes in agy's
  `trustedWorkspaces` (`agyTrust`, `OVERBRIDGE_AGY_SETTINGS` in tests). `src/agy-hook.ts` translates agy hook payloads to Claude's shape
  (`fromAgy`) for `guard --agy` (one decision per agy entry, so it records the call too through `recordHook`) and `hook --agy`;
  the hook imports it, so it imports only `json.ts`. `src/send.ts` (`overbridge send`) types into an agent pane (`Mux.sendText`),
  which is how the orchestrator reaches agy, since agy has no `SendMessage`.
- `src/guard.ts` is the Claude PreToolUse hook; pure `check()` is unit-tested in `test/guard.test.ts`.
  Exit 2 = block. Fail closed on internal errors. The root `config.yml`'s `guard` block (`GuardConfig`) adds
  `read-paths` (reads only) and `deny` rules; it is never read from a repo file, so a branch can't loosen the guard.
- `src/claude-trust.ts` records Claude folder trust in `~/.claude.json` (`$CLAUDE_CONFIG_DIR` when set) for workspace
  folders only: `createWorkspace` and `claude()` trust, `removeWorkspace` untrusts. Claude rewrites that file while
  it runs, so change only the one key and write it with an atomic rename. Tests run through `test/run.ts` (`just test [files]`,
  `bun run test [files]`), which starts `bun test` with a temp `OVERBRIDGE_ROOT`, Claude config and agy settings, and without
  the workspace's `OVERBRIDGE_NAME`/`SELF`/`SESSION`/`TAB` or `$TMUX`. Bun builds a child's environment from the one it
  started with, so only the runner reaches the CLIs a test spawns; the `bunfig.toml` preload (`test/helpers/isolate-env.ts`)
  refuses a plain `bun test`.
- `src/state.ts`: all claim mutations go through `withState()` (lockfile + atomic rename; throw = no write).
- `test/e2e.test.ts` drives the real CLI against a temp `OVERBRIDGE_ROOT` and a local bare "remote".
- Generated files (`<ws>/.claude/settings.json`, `<ws>/CLAUDE.md`, layout) come from
  `src/scaffold.ts` / `src/layout.ts`; they must stay idempotent.
  The agent starts in `agentDir` (`src/layout.ts`: the first repo's worktree, so `overbridge.yml`, `item`, `config` and `ext`
  resolve; the workspace root with no repo or only root transcripts) and loads `<meta>/workspaces/<ws>.settings.json`
  through `--settings`, since Claude reads `.claude/settings.json` only from its own folder.
- `src/stack.ts` reads gh-stack's catalogs (`<bare>/worktrees/*/gh-stack`, then the older shared `<bare>/gh-stack`); claims cover whole stacks via `cover()`.
- Installed from nix-home's `ws` flake input (to be renamed `overbridge`), which is pinned. After a PR merges to `main`, bump it in
  nix-home (`nix flake update ws`, own commit + PR) or the installed `ws` stays on the old rev.
- `src/plugins.ts` enables both plugins from the installed package (`packageRoot()`) as a directory marketplace,
  through each workspace's settings.json and `claude --settings` (`scaffoldPlugins`); `start` refuses when the
  package ships no plugins. The flake copies `.claude-plugin`, `plugin` and `plugin-review` beside `src`.
- Plugin skills in `plugin/skills/`; keep them in sync with CLI commands/flags. Skills mark extension points with
  `ext: <phase>` lines (`src/ext.ts`, `overbridge ext`); a new or renamed phase goes in the skill's Extensions
  section and the README's phase table.
- Neither `plugin.json` has a `version`, on purpose. Claude Code then versions each plugin by its git commit, so
  `claude plugin update` picks up every push to `main`. A fixed version makes it skip new commits until someone bumps it.
- Review panel is a second plugin, `plugin-review/` (`overbridge-review`): `mob-review`, `review-pr`, `update-personas`,
  `persona-*`. A new persona needs a row in `mob-review`'s panel table; keep its README list in sync.
