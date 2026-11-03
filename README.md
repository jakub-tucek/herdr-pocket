# Herdr Pocket

Mobile SSH terminal app for existing **herdr-core + Herdr app** sessions.
Browse synced workspaces, launch coding sessions in two selections, and use them
through a phone-sized terminal with persistent navigation. No tmux, browser,
HTTP service or new daemon.

## Run

```sh
git clone git@github.com:jakub-tucek/herdr-pocket.git
cd herdr-pocket
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
pnpm install:cli
~/.local/bin/herdr-pocket
```

Requires Node 24, pnpm 12 and `hc` (`~/.local/bin/hc`, PATH, or `HC_BIN`).
The installer pins the current Node path so SSH does not need an interactive shell
setup. Re-run `pnpm install:cli` if that Node installation moves.

In Termius, SSH into the machine that owns your Herdr sessions and connections
(over Tailscale or your usual SSH network):
- Host: that machine's hostname or IP
- User: your SSH username; port `22` unless configured otherwise
- Startup command: `~/.local/bin/herdr-pocket`

With `~/.local/bin` on PATH, run `herdr-pocket` directly. No alias needed.
Install OpenCode on each target machine to use the **+ OpenCode** action.

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

Pocket runs `hc attach` in a private PTY and renders its output through a headless
xterm screen buffer. Apps can clear, scroll, switch alternate screens and resize
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

`pnpm test` requires Python 3 and uses isolated core instances, scratch HOME/XDG
paths, real Git repositories and PTYs. It checks publication conflicts, repo and
worktree grouping, exact workspace reuse, two-click shell creation, live sync from
another client, terminal input/rendering/resize, mouse and keyboard return, hangup,
TTY restoration and survival of underlying sessions. It never stops the user's core.

`node-pty` is the native dependency. `scripts/setup-pty.mjs` fixes the missing
executable bit on its published macOS helper during install.

## Relics

All experiments remain reachable in this repo's Git history:
- `relic/pwa`: `relic/pwa`, abandoned PWA.
- `relic/tui`: original plain SSH picker.
- `relic/tmux`: `relic/tmux`, abandoned tmux toolbar.

Those old installations were removed. The current app installs only the
`~/.local/bin/herdr-pocket` launcher; no service, proxy or port mapping.
