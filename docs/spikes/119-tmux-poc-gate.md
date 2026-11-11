# tmux proof-of-concept gate under Ghostty

Issue: [#119](https://github.com/DavidDudson/overbridge/issues/119). Follow-up to
[the zellij spike](107-remove-zellij.md). Harness and config: [`119-tmux-poc/`](119-tmux-poc/).

Run 2026-11-11 on tmux 3.8, Ghostty 1.4.0, Claude Code in a pty-driven tmux pane, `TERM=xterm-ghostty`.

## Verdict

**Pass, with one manual check left.** No blocker for the Mux adapter. Everything tmux-side is verified; what a
script cannot do is press physical keys in Ghostty, so Ghostty's own encoding of Shift+Enter is not observed (see
"Not verified").

Config under test (`119-tmux-poc/tmux.conf`): `prefix None`, `status off`, `mouse on`, `extended-keys always`,
`terminal-features 'xterm*:extkeys'`, `allow-set-title off`, `default-terminal tmux-256color`,
`terminal-overrides ',*:RGB'`.

## Results

| Check | Result | Evidence |
| --- | --- | --- |
| tmux asks Ghostty for extended keys | Pass | tmux writes `ESC[>4;2m` (modifyOtherKeys 2) to the outer terminal on attach |
| Shift+Enter reaches the pane app | Pass | With outer `ESC[27;2;13~` the pane reads the same bytes, whether the app asked for nothing, modifyOtherKeys or kitty (`always` forwards unconditionally) |
| Ctrl+Enter reaches the pane app | Pass | Pane reads `ESC[27;5;13~` in all three app modes |
| Shift+Enter in real Claude Code | Pass | Typing `AAA`, Shift+Enter, `BBB` leaves a two-line input (`❯ AAA` / `  BBB`) and does not submit |
| Ctrl+Enter in real Claude Code | Same as today | Submits the prompt, which is Claude Code's own binding; tmux does not change it |
| Plain Enter | Pass | Pane reads `0d` |
| Mouse in a split pane | Pass | Click at outer (10,12) over a 60-column sidebar arrives as `ESC[<0;10;12M` / `m`, wheel as `ESC[<64;10;12M`; a click in the neighbouring pane does not leak into the sidebar |
| Truecolour | Pass | `ESC[38;2;10;20;30m` and italics (`SGR 3`) reach the outer terminal; pane `$TERM` is `tmux-256color` |
| Hidden-window CPU | Pass | 28 windows, 82 panes, each redrawing 20 rows 5x/s, one client attached: server 6.6 % of a core over 30 s, 36 MB RSS, 1 thread (spike benchmark C: 7.6 %) |
| OSC title with `allow-set-title off` | Pass | A pane that prints `ESC]2;HIJACK BEL` and `ESC]0;...` keeps the title set with `select-pane -T`. Control with `allow-set-title on` becomes `HIJACK` |
| Exact-name target for `@root` | Pass | `-t 'workspaces:=@root'` resolves to the window named `@root` (`@0`) |

Other observations:

- The pane border costs one column (a 60-wide sidebar leaves the next pane at `pane_left=61`).
- A pane started without `select-pane -T` gets the hostname as its title, so the adapter must set a title on every pane it
  creates and look panes up by it.
- Claude Code in tmux shows its input box, status line and `auto mode` footer correctly; the "Transcript saving is off"
  warning came from this session's inherited environment, not tmux.

## Not verified

- **What Ghostty emits for a physical Shift+Enter once tmux has sent `ESC[>4;2m`.** The harness feeds the
  modifyOtherKeys bytes in place of Ghostty. To close it, in a Ghostty window run
  `tmux -L poc -f docs/spikes/119-tmux-poc/tmux.conf new-session claude`, type `a`, press Shift+Enter, type `b`: the
  prompt must show two lines. If it submits instead, set `extended-keys-format csi-u` and retry before blocking #120.
- Real Claude TUIs in the hidden windows (the CPU run uses a redraw stand-in, as in the spike's benchmark).
- Mouse through Ghostty itself (bytes were injected at the tmux client).

## Consequences for #120

- Use the config above as the generated tmux conf; no change to the migration outline.
- The adapter's `listPanes` must key on titles it set itself, and every orchestration name must be `=`-prefixed.
