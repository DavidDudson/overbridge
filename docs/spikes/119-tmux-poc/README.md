# tmux PoC harness (issue #119)

Scripts behind [the findings](../119-tmux-poc-gate.md). Each drives a throwaway tmux server (`-L poc119*`), never
the live session. Run from this directory with a tmux 3.8 path:

```
nix shell nixpkgs#tmux -c python3 drive.py "$(which tmux)"        # extended keys + mouse via a pty client
nix shell nixpkgs#tmux -c python3 claude_keys.py "$(which tmux)"  # real Claude Code in a tmux pane (sends one tiny prompt)
```

`tmux.conf` is the candidate config; `redraw.sh` is the hidden-window load; `reader.py` and `mrd.py` print the raw bytes
a pane app receives. They fake the *outer* terminal's bytes; they cannot press keys in Ghostty itself.
