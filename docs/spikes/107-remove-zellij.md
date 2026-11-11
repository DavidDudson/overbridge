# Spike: remove zellij in favour of a lighter-weight system with fewer keybinds

Issue: [#107](https://github.com/DavidDudson/overbridge/issues/107). Investigation only; nothing here is implemented.

## Recommendation

**Go: replace zellij with tmux, behind a small multiplexer adapter, after two cheap config fixes that ship first.**

1. **Now (config only, no overbridge code):** put zellij's `default_mode` to `locked`, keep only the handful of
   Alt bindings, and drop the `zellij:status-bar` plugin from the generated layout. This removes every mode and
   every Ctrl chord today, and the status-bar plugin is where most of the zellij server's CPU goes (measured below).
   Measure again after that.
2. **Then:** migrate to tmux. It is the only alternative that has every primitive overbridge drives (checked with a
   proof of concept, below), it has no plugin runtime or per-tab wasm instance, and with `prefix None` it has no
   modes and no bindings unless we add them. Ghostty-native tabs and Hyprland windows do not fit (reasons below).

A controlled benchmark at overbridge's real shape (28 tabs, 83 panes, same stand-in load; table below) puts
zellij-as-today at 79 % server CPU idle and 4.3 s to open a tab, zellij without the status bar at 6 % and 0.45 s,
and tmux at 0 % and 18 ms, with 6 MB against 82–310 MB of RSS. Step 1 is worth taking today; step 2 is worth
the migration.

The keybind goal is reachable with either multiplexer, because the fix is not the multiplexer: the few
tab-switching keys move either to the multiplexer's root table (Alt chords, no modes) or out of the terminal
entirely, to Hyprland `SUPER` chords that run `overbridge go <n>|next|prev`. `SUPER` never reaches a TUI, so that is
the literal "no multiplexer-level keybinds" setup, and it works with zellij today (`zellij --session workspaces
action ...`) and with tmux tomorrow (`tmux select-window -t workspaces:=<name>`).

## What overbridge uses zellij for today

Every zellij call site, from `rg zellij src/` (31 files mention it; these are the ones that run it):

| Feature | Where | zellij calls |
| --- | --- | --- |
| Session launch / attach / rebuild (`up`, `spinup`) | `src/commands.ts` | `list-sessions`, `attach`, `--new-session-with-layout`, `kill-session`, `delete-session` |
| Generated layout: `@root` tab, then one tab per workspace, each sidebar + top + Claude | `src/layout.ts` | KDL `layout {}` with `default_tab_template` holding `zellij:status-bar`; `borderless`, `size`, `focus`, `cwd`, `command/args` |
| Open a workspace tab in the background, with a prompt, then return focus | `src/tab.ts` (`openTab`), `src/start.ts` | `new-tab --layout --name`, `query-tab-names`, `current-tab-info`, `go-to-tab-name` |
| Switch tab and focus its sidebar | `src/sidebar.ts` (`switchTab`, `registerPane`), `src/next.ts` | `go-to-tab-name`, `focus-pane-id terminal_<id>`, `$ZELLIJ_PANE_ID` |
| Terminal / diff / Claude pane buttons | `src/panes.ts` | `list-panes --json`, `focus-pane-id`, `close-pane --pane-id`, `new-pane --direction --name --cwd [--close-on-exit]` |
| Remove a workspace: leave its tab, close it by id, reopen on failure | `src/remove.ts` | `list-tabs`, `close-tab-by-id`, `query-tab-names`, `openTab` |
| Keep `@root` open: reopen and walk it to the front | `src/orchestration-keep.ts` | `query-tab-names`, `current-tab-info`, `new-tab --layout`, `move-tab left`, `go-to-tab-name` |
| Am I inside the session; which session | everywhere via `process.env.ZELLIJ`; `src/sidebar-history.ts` | `$ZELLIJ`, `$ZELLIJ_SESSION_NAME` |
| `overbridge next` from a key | nix-home `config.kdl` `Alt w` | `Run "overbridge" "next"` in a 1x1 floating pane |
| Packaging | `flake.nix` (`zellij` on PATH), `package.json`, README, `CLAUDE.md`, `src/main.ts` help, `plugin/skills/workspace*/SKILL.md` | wording and the PATH suffix |

Tests that fake zellij argv: `test/start.test.ts`, `remove.test.ts`, `layout.test.ts`, `orchestration-keep.test.ts`,
`sidebar.test.ts`, `sidebar-history.test.ts`, `merge-sweep.test.ts`, `attention.test.ts`, plus `ZELLIJ_CONFIG_DIR`
isolation in the e2e tests (29 references).

nix-home: `home/programs/zellij/{default.nix,config.kdl}` (323-line keybind config), `modules/programs/terminal.nix`
(system package), `home/home.nix` import, `CLAUDE.md` tree. The terminal emulator is Ghostty 1.4 (`home/programs/ghostty.nix`),
the WM is Hyprland (`home/desktop/hyprland/keybindings.lua`). No user `layouts/overbridge.kdl` exists, so the layout
override path is unused.

### Needed vs incidental

Needed (overbridge's behaviour depends on them):

- Named tabs, one per workspace, opened in the background with a three-pane layout and a first prompt.
- List tabs, current tab, go to tab by name, close tab by stable id, move a tab to the front.
- Panes: list with titles, focus by id, close by id, open to the right/below with a cwd and command.
- Session: exists / attach / create from layout / kill; "am I inside it" and its name.
- Mouse clicks reaching the sidebar and top panel (SGR 1006 passthrough).

Incidental (replaceable or droppable):

- `zellij:status-bar` plugin per tab. The sidebar already numbers and lists tabs; the status bar duplicates it.
- Floating pane for `Alt w` → `overbridge next`. Any "run a command silently" binding does this.
- `borderless=true`, rounded frames, themes, `copy_command`, `scrollback_editor`: cosmetics.
- Session resurrection. `overbridge up` attaches when the session exists and rebuilds the layout from `state.json`
  otherwise; Claude resumes with `--continue`. Nothing relies on zellij serialising the session.
- The user layout override (`layouts/overbridge.kdl`). Unused.
- Text parsing of `current-tab-info` and `list-tabs` (regexes over human-readable output in `tab.ts`, `remove.ts`,
  `orchestration-keep.ts`). A liability, not a feature.

## The keybind problem, precisely

`config.kdl` defines nine modes and reaches them with `Ctrl g/p/t/n/h/o/s/b/q`. Claude Code binds `Ctrl b`
(background), `Ctrl o` (verbose), `Ctrl t` (todos) and `Ctrl g` (external editor) itself; helix and nushell use
several of the rest. Every one of those chords is intercepted by zellij before the app sees it, and the mode keys
then swallow the next plain key too. That is the collision the issue describes, and it is entirely in the config:
zellij's `locked` mode passes everything through except what is bound inside `locked {}`.

What actually needs a key at the multiplexer or WM level, once the sidebar does the rest with `j/k`, digits, `n`,
`s`, `h/l` and clicks:

| Action | Today | Proposed |
| --- | --- | --- |
| Go to tab 1–9 | `Alt 1`–`Alt 9` | same, or `SUPER+ALT+1..9` in Hyprland → `overbridge go <n>` |
| Prev / next tab | `Alt ,` / `Alt .` | same, or Hyprland |
| Next tab needing attention | `Alt w` (floating `overbridge next`) | same, or Hyprland → `overbridge next` |
| Focus sidebar / Claude / terminal pane | `Alt h/j/k/l` | mouse click, or `Alt h/l` only |
| Everything else (resize, move, float, rename, search, session manager) | 9 modes | dropped; `overbridge` commands and the mouse cover them |

So the target is three to twelve root-level Alt bindings and zero modes, or zero terminal-level bindings with the
same twelve on `SUPER` chords. Hyprland already owns `SUPER+1..0` (workspaces) and `SUPER+CTRL+SHIFT+<n>`;
`SUPER+ALT+<n>` is free.

Note the limit: with one process per pane, the sidebar's own keys (`j`, `k`, `s`, digits) only work while the sidebar
pane has focus. "Every key in the same panel" means the tab-switching keys live at the root table or WM; it cannot
mean the sidebar's keys work while Claude has focus, short of writing our own multiplexer (see "Not viable").

## Measurements (live session, 2026-11-10)

28 tabs (`@root` + 27 workspaces), 28 Claude sessions, one sidebar and one top process per tab.

| What | Value |
| --- | --- |
| zellij server RSS | 494 MB, 113 threads |
| zellij server CPU (three 2 s samples, `top`) | 185 %, 139 %, 95 % |
| Busiest zellij threads | `plugin-*` 88 %, `screen` 14 %, `wasm` 11 % |
| overbridge pane processes (bun) | 83, ≈ 50 MB each, ≈ 4 GB |
| Claude processes | 28 ≈ 7.1 GB |

Reading: a core is burnt by the status-bar plugin instances (one wasm plugin per tab, re-rendered on every
pane update anywhere in the session) and by zellij's own screen model, with 27 Claude TUIs redrawing in hidden tabs.
tmux has neither a plugin runtime nor a wasm host; hidden windows cost it only VT parsing. The bun processes are
overbridge's own cost (three per tab) and belong to the performance epic, not to this spike; they are the same under
any multiplexer.

### Controlled benchmark: A zellij as today, B zellij without status-bar, C tmux

Same load for all three, in throwaway servers (`zellij --session bench107-a/-b`, `tmux -L bench107`), never the
live session. 28 tabs (`@root` + 27 workspaces) with overbridge's exact pane layout: the zellij KDL came from
`layoutKdl` in `src/layout.ts` (B is the same KDL with `default_tab_template` and its `zellij:status-bar` removed);
C rebuilt it with `new-window` / `split-window -b -h -l 60` / `split-window -b -v -l 5`. One client attached to each
server through a 220x60 pty (`script`). zellij ran the user's `config.kdl` from nix-home; tmux ran
`prefix None`, `status off`, `mouse on`, `extended-keys always`, `allow-set-title off`. Each of the 83 panes ran
the same `sh` stand-in: **idle** (sleep), **steady** (3 lines/s per pane, ~250 lines/s in all), **redraw** (a
20-row cursor-home frame 5x/s per pane, the closest cheap imitation of a TUI spinner). Server CPU is `top`
averaged over 30 s per phase (the cputime delta over the same 30 s agreed in every case); RSS and threads are the
server's at the end of each phase; latencies are the CLI round trip (`go-to-tab-name` / `select-window`, and
`new-tab --layout` / `new-window` + two splits), averaged over 10 and 3 calls. Harness: scratchpad `bench107/`.

| | A: zellij 0.45.1 + status-bar | B: zellij 0.45.1, no status-bar | C: tmux 3.8 |
| --- | --- | --- | --- |
| Server CPU, idle | 78.7 % | 6.0 % | 0.0 % |
| Server CPU, steady output | 84.5 % | 8.4 % | 1.7 % |
| Server CPU, redraw | 101.9 % | 25.4 % | 7.6 % |
| Server RSS idle → redraw | 310 → 516 MB | 82 → 313 MB | 6 → 45 MB |
| Server threads | 113–126 | 101–116 | 1 |
| Switch tab (avg) | 67 ms | 12 ms | 3 ms |
| New tab with 3 panes (avg) | 4334 ms | 454 ms | 18 ms |

The attached client used 0.0–0.1 % CPU in every case (it relays bytes; the server does the work).

Reading:

- The status-bar plugin is most of zellij's cost: removing it cuts idle CPU 13x and tab opening 10x, which
  confirms step 1 of the recommendation as a near-free win.
- tmux is still an order of magnitude lighter than B at every point (idle 0 % vs 6 %, redraw 7.6 % vs 25.4 %, 6 MB vs
  82 MB, one thread vs ~100), and 25x faster to open a tab. Under a redraw-heavy load zellij's remaining cost is its
  screen model and plugin host, not the status bar.
- A's 79 % idle matches the live session's 95–185 % (28 real Claude TUIs produce more output than the stand-ins).

Caveats:

- Stand-ins are `sh` loops, not Claude Code or the bun sidebar/top panes. They produce simpler escape sequences
  and less output than Claude, so absolute numbers are lower than real use; the ranking is what the benchmark shows.
- One run per variant on a busy machine (the live 28-tab session was running alongside), 30 s per phase.
- Latencies are CLI round trips, not time-to-pixels.
- In C the `@root` window's sidebar split failed, because tmux reads a target starting with `@` as a window id
  (`-t workspaces:@root`); it needs the exact-name form `-t 'workspaces:=@root'`. So C ran 82 panes, one idle pane
  short of A and B, which does not change the picture. The adapter must use `=`-prefixed targets for every
  orchestration tab.

## Alternatives

### tmux 3.8 (recommended replacement)

Proof of concept run in a throwaway server (`tmux -L spike107`): `new-session -d -s workspaces -n @root`,
`new-window -d -n <ws> -c <dir> '<cmd>'`, `split-window -b -h -l 60` (sidebar) and `-b -v -l 5` (top),
`select-pane -T '<ws> · claude'`, `list-windows -F '#{window_id} #{window_name} #{window_active}'`,
`list-panes -s -F '#{pane_id} #{window_name} #{pane_title} #{pane_dead}'`, `display -p '#{window_name}'`,
`select-window -t =<name>`, `swap-window -t 0` (move to front; `move-window` refuses a used index),
`kill-window -t @<id>`, `kill-server`, `bind -n M-1 select-window -t :1`, `run-shell -b`. All of it works and
every value comes back through `-F` format strings, so the regexes over zellij's text output go away.

Fits the goal: `set -g prefix None` leaves tmux with no prefix and no modes except copy-mode, which only the mouse
wheel or an explicit bind enters, exactly like zellij's scroll mode. `set -g status off` removes the bar. Root-table
Alt binds are the only bindings, and they can be zero if Hyprland owns them.

Trade-offs:

- Pane borders cost one column/row; tmux has no `borderless`. `pane-border-style fg=<background>` hides them.
- No kitty keyboard protocol. tmux 3.8 forwards CSI u / modifyOtherKeys with `set -s extended-keys always` and
  `set -as terminal-features 'xterm*:extkeys'`. Claude Code's Shift+Enter and Ctrl+Enter depend on this; it must be
  the first thing the PoC checks under Ghostty. zellij 0.45 supports the kitty protocol natively.
- Apps may rename panes with OSC titles (Claude Code does); `set -g allow-set-title off` keeps the titles
  `panes.ts` finds panes by.
- A target that starts with `@` is a window id to tmux, so orchestration tabs (`@root`) must always be addressed
  by exact name: `-t 'workspaces:=@root'`. The adapter should `=`-prefix every name it passes.
- No floating panes; `overbridge next` runs with `run-shell -b` instead.
- No layout file. `overbridge layout` prints the tmux command script instead of KDL; the user override file goes.
- Scrollback/copy: tmux copy-mode with `mouse on`; `copy_command wl-copy` becomes `copy-command 'wl-copy'`.
- Colours and italics need `default-terminal tmux-256color` and `terminal-overrides ',*:RGB'`.
- Available on macOS, which overbridge already accommodates (`src/proc.ts`).

### Keep zellij, fix the config (interim, do regardless)

`default_mode "locked"`, `keybinds clear-defaults=true { locked { bind "Alt 1".. "Alt 9", "Alt ,", "Alt .", "Alt w",
"Alt h/l" } }` and nothing else. Zero modes, no Ctrl chords. Remove `zellij:status-bar` from `TAB_TEMPLATE` in
`src/layout.ts`. Cost: an hour. It also gives the measurement baseline that decides how urgent the tmux move is.

Why not stop here: the plugin runtime and the screen model are zellij's architecture; after the status bar goes
there is still a Rust server with a wasm host rendering 28 hidden Claude TUIs, and overbridge still scrapes
human-readable output. If the post-fix CPU is low single digits, the tmux migration can wait; the adapter is still
worth having.

### Not viable

- **Ghostty tabs/splits.** Ghostty 1.4 exposes `+new-window` and `+new-tab` over D-Bus, nothing else: no list,
  focus-by-name, close, split or run-in-pane. overbridge cannot drive it, and three panes per workspace would still
  need a multiplexer inside each tab.
- **Hyprland windows/groups as tabs.** `hyprctl` can spawn and focus windows by class/title, and groups give tabs,
  but three windows per workspace × 27 workspaces, focus and sizing at the WM level, and a hard Hyprland dependency
  (overbridge runs on macOS). Use Hyprland only for the keybinds.
- **Plain terminals + CLI.** Loses the sidebar, top panel and background tab opening, which is most of overbridge.
- **Own host TUI embedding Claude in a PTY** (the `claude-popout` pattern). The only design where sidebar keys
  work while Claude has focus, but it means writing a VT parser/renderer and a mini multiplexer in Bun. Heavier,
  not lighter.

## Migration outline (tmux)

Riskiest first.

1. **PoC gate (half a day).** tmux config in a scratch profile under Ghostty: Shift+Enter / Ctrl+Enter in Claude
   Code with `extended-keys always`; mouse clicks in sidebar and top; colours; 25+ hidden windows CPU. Stop here if
   Shift+Enter cannot be made to work.
2. **`src/mux.ts` adapter.** One interface (`inSession`, `sessionName`, `paneId`, `tabs`, `currentTab`, `goToTab`,
   `openTab(name, panes)`, `closeTab`, `moveTabToFront`, `listPanes`, `focusPane`, `closePane`, `newPane`,
   `sessionExists`, `attach`, `createSession`, `killSession`) with a zellij backend lifted from today's code and a tmux
   backend; detection by `$TMUX` / `$ZELLIJ`. Call sites: `tab.ts`, `panes.ts`, `remove.ts`, `orchestration-keep.ts`,
   `sidebar.ts`, `sidebar-history.ts`, `next.ts`, `start.ts`, `commands.ts`. Tests swap their zellij argv fakes for
   a fake `Mux`; `layout.test.ts` and its snapshot cover both backends.
3. **Layout.** `layout.ts` emits a tmux command list (session + `@root` window, then per-workspace window, sidebar
   split, top split, pane titles, `select-window` on the first), keeping `layoutKdl`'s idempotence. `overbridge layout`
   prints it. `up` runs it with `tmux -f <generated conf>`; `spinup` is `kill-server` + `up`.
4. **`overbridge go <n>|<name>|next|prev`.** Thin command over the adapter so WM binds and both backends share it;
   `overbridge next` already exists.
5. **nix-home.** `programs.tmux` (prefix None, status off, mouse on, extended-keys, allow-set-title off, border
   colour, `copy-command`, optional Alt root binds) replaces `home/programs/zellij`; `modules/programs/terminal.nix`
   swaps the package; optional `SUPER+ALT+<n>` / `SUPER+ALT+w` binds in `keybindings.lua`. Bump the `ws` flake input
   after the overbridge PR merges.
6. **overbridge packaging and docs.** `flake.nix` PATH suffix, `package.json`/`flake.nix` descriptions, README
   (Zellij tabs, Layout, Tab sidebar, environment table `OVERBRIDGE_SESSION`), `CLAUDE.md`, `src/main.ts` help
   ("Zellij" section), `plugin/skills/workspace-admin/SKILL.md`, `plugin/skills/workspace/SKILL.md`.
7. **Retire the zellij backend** once tmux has run for a few weeks, or keep both if the adapter stays small.

## Proposed follow-up issues

1. nix-home: zellij `locked` default mode with Alt-only bindings (interim, config only).
2. overbridge: drop `zellij:status-bar` from the generated layout; record server CPU before and after.
3. overbridge: `overbridge go <n>|<name>|next|prev`; nix-home: Hyprland `SUPER+ALT` binds for it.
4. overbridge: tmux PoC gate (Shift+Enter, mouse, colours, hidden-window CPU under Ghostty).
5. overbridge: `Mux` adapter with zellij and tmux backends; layout as a tmux command script.
6. nix-home: `programs.tmux` config, package swap, flake bump; overbridge docs and skills sweep.
