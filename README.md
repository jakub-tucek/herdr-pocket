# Herdr Pocket TUI

Mobile terminal client for **herdr-core + Herdr app sessions**, over Termius/SSH.
No browser, HTTP service, pairing key or iOS web-keyboard accessory bar.

## Connect

SSH to the Mac that owns your Herdr machine connections, then run:

```sh
~/.local/bin/herdr-pocket
```

Termius host: `host.example.invalid`, user `example`, port 22.
Tailscale must be connected. Set the command above as the host's startup command.

- Enter/tap: open a space or terminal.
- Swipe/wheel or arrows: move through the picker.
- `Esc`: spaces; `/`: search; `n`: new session; `w`: worktree; `?`: keys.
- **Inside a terminal, Ctrl+\ returns to the picker.** Programs keep running.

Termius owns the keyboard, scrolling, selection and clipboard while attached.
The TUI runs `hc attach` with the real SSH TTY, not another terminal renderer.
Each attachment fits the existing terminal to your phone; desktop views may reflow.

## Shared sessions

The picker reads each machine's core `herdr-app` document and live terminal facts.
The desktop app does not need to be open. Focus/navigation stays local to this
client. Names, tabs, splits, live terminals and attention use the shared core state.
Native GPUI mod panes are labeled desktop-only; no fake terminal is created for them.

New sessions create a core terminal and publish a tab/space into the shared layout.
Writes use version-checked `doc.set` retries that preserve unrelated fields. Herdr
labels are applied after publication, avoiding its automatic-adoption race.
Desktop Herdr picks up the same terminal. Opening a session never restarts an agent.
The default launcher is OpenCode; Shell uses the machine's core default shell.

Worktrees use Git on the target machine and Herdr's usual
`~/.herdr/worktrees/<repo>/<branch-slug>` path. No force, deletion or cleanup of
existing work is offered. If launching fails after checkout creation, the checkout
is kept. The TUI can list and open existing worktrees too.

## CLI

```sh
herdr-pocket --list
herdr-pocket --list --json
herdr-pocket --attach t1f
herdr-pocket new --program shell --machine remote --name Scratch
herdr-pocket tree --repo ~/repo --branch phone/fix --program opencode
```

No tmux is required: core keeps every program alive after SSH disconnects.
If you already use tmux, run this client inside it; don't run agents twice.
The installed `herdr` TUI is unrelated and remains untouched.

## Develop

Node 24, pnpm 12, `hc` on PATH or `HC_BIN` pointing at it.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
pnpm start
```

Tests use a separate core/session, scratch HOME/XDG paths, real Git and a real
pseudo-terminal. They check shared-layout writes, concurrent edits, terminal
launch, worktrees, raw input, attachment, detach, resize and TTY restoration.
They never stop or restart the user's core. Python 3 is needed for the PTY test.

State: `~/.local/state/herdr-pocket-tui/view.json` (selected space/pane only).
The only running client is the foreground TUI; no new daemon or listening port.

Archived PWA: `../herdr-pocket`, checkpoint commit `relic/pwa`.
