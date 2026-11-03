# Herdr Pocket

**Your Herdr workspaces and running sessions, from your phone.**

A mobile-friendly terminal CLI built in Rust. Connect through **Termius** or
another SSH client, run `herdr-pocket`, and pick up the same shell or coding-agent
session you use in **Herdr app**. No duplicate agent or separate workspace setup.

- **Shared sessions:** use the existing terminals managed by herdr-core.
- **Shared workspaces:** browse Herdr spaces, tabs and split-pane terminals.
- **Two-step creation:** choose a repo, then OpenCode or Shell.
- **Phone-sized controls:** compact lists, numbered shortcuts and a pinned Picker bar.
- **Persistent programs:** disconnect SSH and reconnect later; core keeps them running.

One native binary for macOS and Linux. No Node, tmux, browser or Pocket server.

## Connect from your phone

Once Pocket is installed on your Herdr host:

1. Open **Termius** and SSH into the machine where you use Herdr, with the same
   user account. Use Tailscale or your usual SSH network.
2. Run:

   ```sh
   ~/.local/bin/herdr-pocket
   ```

3. Choose a repository, or press **Tab** for **Spaces** to browse your shared
   Herdr workspaces. Open a terminal to continue where you left off.

Set `~/.local/bin/herdr-pocket` as the host's **startup command** in Termius to
open Pocket whenever you connect. With `~/.local/bin` on PATH, `herdr-pocket`
works directly too.

**Return to the picker:** press **Ctrl+]**, or tap **‹ Picker** if your SSH client
forwards mouse events. Use number keys to select rows when taps aren't forwarded.

## What stays in sync with Herdr app?

Pocket reads the same shared layout and connects to the same core terminals.
Existing spaces, tabs, terminal titles and agent status appear in Pocket. Sessions
and workspaces created in Pocket appear in Herdr app too. The desktop app does
not need to stay open.

The presentation is adapted for a phone: split-pane terminals become selectable
rows, and **Repos** groups workspaces by detected Git repository. Desktop-only
mod panels are labeled but cannot be opened in Pocket. Navigation and selection
stay local to each client.

Connect to the Herdr host that owns your remote-machine connections to see those
machines too. A different SSH account or a separate core instance has its own state.

## Install on your Herdr host

Requires a recent stable Rust toolchain (edition 2024) and an installed
[herdr-core](https://github.com/herdrdev/herdr-core) with `hc` available.

```sh
git clone https://github.com/jakub-tucek/herdr-pocket.git
cd herdr-pocket
./scripts/install.sh
```

The installer builds a release binary and installs it at `~/.local/bin/herdr-pocket`.
Runtime needs only that binary and `hc` (`~/.local/bin/hc`, PATH, or `HC_BIN`).
Install OpenCode on each target machine where you want to use **+ OpenCode**.
Python 3 is needed for the tests below, not for running Pocket.

## Repos and sessions

**Repo → + OpenCode / + Shell** creates and opens a session in two selections.
No folder/name wizard. Repositories are detected from shared spaces, live terminal
directories and a bounded search of conventional project folders. Git common-dir
identity groups worktrees of the same repo; machines remain separate.

- **Repos**: repository groups, existing sessions, checkout selection.
- **Spaces**: every shared Herdr space, including non-Git folders and split panes.
- **+ Worktree**: creates a unique `pocket/...` branch from HEAD and opens OpenCode
  in a new shared workspace. Select an existing checkout to launch there instead.
- **Tab** switches Repos/Spaces; **Enter**, **1–9**, or mouse press opens a row.
- **↑/↓** or **j/k** moves; **Esc** goes back; **/** searches; **r** rediscovers.
- Within a repo/space: **o/n** OpenCode, **s** shell, **w** worktree (repo only).
- **q** quits. Programs remain alive in core.

World state refreshes every two seconds while browsing. Repo discovery runs on
entry, manual refresh and periodically. Remote failures leave cached repos/spaces
visible as offline. New tabs/spaces publish into the same `herdr-app` document
using version-checked writes, preserving concurrent changes and unknown fields.
Opening an existing session never starts another agent. The desktop need not be open.
Desktop-only mod panels are labeled, not replaced by fake terminals.

## Custom terminal

Pocket runs `hc attach` through `portable-pty`, parses its output with `vt100`,
and renders via `crossterm`. Apps can clear, scroll, switch alternate screens and resize
without overwriting Pocket's two pinned bottom rows.

| Control | Action |
| --- | --- |
| **‹ Picker** | Detach this view; return to sessions |
| **Ctrl+]** or **Ctrl+\** | Keyboard return, including clients without touch mouse events |
| **Esc / Tab** | Send the key to the app |
| **↑ / ↓** toolbar | Scroll history; Page Up/Down in alternate-screen apps |
| **Live** or title row | Return to live output |

Buttons disappear from the right when the screen is too narrow; Picker stays.
Wheel events go to mouse-aware apps, otherwise scroll Pocket's history.
Color, Unicode, cursor, arrows and bracketed paste are preserved. Typing returns
to live output. Resizing fits the shared core terminal to the phone, so other
attached views can reflow.

**Touch requires terminal mouse events.** Termius may use finger taps for its own
gestures rather than send mouse clicks. Pocket cannot change an SSH client's
gesture handling. Number keys work throughout the picker; Ctrl+] returns from
the terminal. The automated mouse tests verify the emitted terminal protocol,
not Termius's iOS gesture implementation.

SSH disconnect stops this Pocket client and its attachment, not the core program.
Reconnect and pick the same session. Local selection is saved in
`~/.local/state/herdr-pocket-tui/view.json`.

## CLI

```sh
herdr-pocket --list --json
herdr-pocket --repos --json
herdr-pocket --attach t1f
herdr-pocket new --program shell --machine remote --name Scratch
herdr-pocket tree --repo ~/repo --branch phone/fix --program opencode
```

## Validation

`cargo test --locked` requires Python 3 and `hc`, and uses isolated core instances, scratch HOME/XDG
paths, real Git repositories and PTYs. It checks publication conflicts, repo and
worktree grouping, exact workspace reuse, two-click shell creation, live sync from
another client, terminal input/rendering/resize, mouse and keyboard return, hangup,
TTY restoration and survival of underlying sessions. It never stops the user's core.

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --locked
cargo build --release --locked
```

## Relics

All experiments remain reachable in this repo's Git history:
- `relic/pwa`: abandoned PWA.
- `relic/tui`: original plain SSH picker.
- `relic/tmux`: abandoned tmux toolbar.
- `relic/node`: last Node implementation before the Rust port.

The current app installs only the `~/.local/bin/herdr-pocket` binary;
no service, proxy or port mapping.
