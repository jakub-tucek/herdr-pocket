# Herdr Pocket

> Archived PWA checkpoint. Development stopped in favor of a Termius-accessible
> TUI using herdr-core and the Herdr app's shared sessions. The PWA service and
> its Tailscale Serve mapping are no longer intended to run.

PWA client for terminals already open in **herdr-app + herdr-core (`hc`)**.
Not the older `herdr` TUI. No session copies, agent relaunches, or remote peer services.

## Run

Node 24 and pnpm 12. Keep the Herdr desktop app open for space discovery.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
POCKET_HOST=your-mac.your-tailnet.ts.net pnpm start
tailscale serve --bg --https=443 http://127.0.0.1:8790
```

The bridge binds only to `127.0.0.1:8790`. Use **Serve**, never Funnel.
Visit the HTTPS address on a Tailscale-connected phone, enter the key from
`~/.config/herdr-pocket/pairing-key`, then Safari → Share → Add to Home Screen.
Pair again in the installed PWA if Safari keeps its cookies separate.

Optional pairing URL: `https://<host>/#pair=<key>`. The fragment stays out of
HTTP requests and is removed immediately; treat the whole link as a password.
The login form still requires Connect.

On this Mac, launchd runs `~/Library/LaunchAgents/dev.herdr-pocket.plist` at login.
Logs: `~/Library/Logs/herdr-pocket{,.error}.log`. The plist pins the Node executable;
update that path before removing the installed Node version.

## Behavior

- Spaces/tabs/panes come from `herdr-app ls`, refreshed every four seconds.
- **+** (or **⋯ → New session**) starts OpenCode or a shell in a new space or an
  existing space's new tab, locally or on a connected SSH machine. Creation uses
  `herdr-app do`, so the resulting session is also visible in the desktop app.
  The phone opens its terminal URL using this device's input preference.
- Enable **Worktree** to create a branch checkout, or load the repo's existing
  checkouts with **↻** and open one. Paths follow Herdr's convention:
  `~/.herdr/worktrees/<repo>/<branch-slug>`, on the selected machine. Existing
  branches are reused without force; existing folders/checkouts are never replaced.
  Git runs as argument arrays, with no shell text. If opening the session fails
  after Git succeeds, the worktree stays on disk and the error gives its path.
- Compact overview: one collapsed row per space, with aggregate agent status and
  terminal count. Tap to expand its tabs/terminals; sub-agents fold separately.
  Expansion stays across refreshes. Search expands matches automatically.
- Raw terminal streams use `hc connect`, generation-1 framed `terminal.attach`.
- Remote terminal addresses pass through the Mac core's existing SSH connections.
- **Control** and direct terminal typing are the defaults. Choosing **Watch**
  sticks on this device across navigation, refreshes, and reconnects. No input
  permission flag is accepted from URLs. On phones, **Fit screen** is enabled:
  the live terminal fits the available width and height, including rotation and
  keyboard changes. This resizes the shared terminal, so its desktop view may reflow.
  **Actual size** disables fitting; the viewer then never resizes the terminal and
  wide desktop grids scroll horizontally. The choice stays in this browser.
  Control always fits its shared terminal; actual-size non-resizing views require Watch.
  Older SSH cores refresh the stream after a desktop resize; newer ones relay
  ordered resize notifications directly.
- Control enables input and fits the shared terminal to this screen.
- Control mode defaults to direct terminal typing: tap the terminal to type.
  **⋯ → Compose** opens the optional one-line composer, which grows to four lines. Enter sends;
  Shift+Enter adds a newline. **⌘** toggles an optional key strip with Esc,
  Tab, one-shot Ctrl, arrows and Enter. The **⋯** menu contains sizing and input
  controls: **Terminal** switches to direct terminal keyboard input; **Compose**
  switches back without losing the draft. The chosen Control/Watch mode survives
  reconnects and updates; direct input is the default whenever enabled. There is no
  persistent mode/status text row; only errors or disconnects show a message.
  The key strip hides when the keyboard closes. The compact composer
  stays available. Browser address bars and iOS keyboard accessory controls are
  system UI; installing to the home screen removes Safari's address bar.
  Both typing modes keep the shortcut strip collapsed by default; **⌘** opens
  its slim 28px row without dismissing the keyboard. Bottom safe-area padding is
  removed while typing on phones. **Unpair** lives under the overview's **⋯**
  menu with a confirmation, not in a permanent footer.
  Fitting can reflow the desktop terminal. Actual-size mode does not restore its prior size;
  the desktop client resumes its own sizing when it takes control.
- Navigation stays in this browser; no desktop `space.select`/`pane.focus` commands.
- The URL owns navigation: `/?terminal=remote%2Ft2q` opens that live terminal;
  `/?q=security` keeps an overview search. Refresh, copied links, and browser
  Back/Forward restore the same screen after Herdr discovery completes. Unknown
  or closed terminals return to the overview. Input mode comes from this device's preference.
  Per-tab session storage keeps expanded rows, scroll position and drafts across
  regular refreshes and updates; a different deep link overrides any saved view.
- Swipes scroll normal terminal history locally, and become mouse-wheel input in
  full-screen apps that capture the mouse. Swiping preserves keyboard focus;
  viewport resizing no longer blurs it. Watch never sends mouse/keyboard input.
- **⋯ → Upload file** accepts files/photos. **⋯ → Paste file** reads clipboard
  images/files where the browser permits it. Native paste with a file also works.
  Files (up to 8 MB each) go through `terminal.put` to the selected terminal's own
  machine and core-managed folder; the core removes them with the terminal.
  Their paths are pasted without Enter, or added to an optional composer draft.
  If navigation changes during upload, the paste waits for its original terminal.
  Clipboard permission failures leave the file picker available. No permanent
  upload or keyboard toolbar is added. The iOS ✓/arrows accessory bar is system UI;
  a native wrapper is required to hide it reliably.
- Closing the page only
  detaches a viewer; it never kills a terminal.
- One terminal at a time, with its live colors and screen. Native GPUI mod panes
  (including Review panels), Kitty images, and desktop split-layout rendering are
  not implemented. Unsupported mod-only tabs are labeled explicitly.
- Sub-agent status is not supplied by `herdr-app ls`; children have neutral dots.
- Mac must be awake and reachable. Offline mode is intentionally unavailable.
- New builds show a small **Update ready** banner; checks run once a minute and
  when the app returns to the foreground. **Refresh** preserves the selected
  terminal, expanded overview, sizing choice, search and unsent draft, reconnecting
  with this device's input preference. **Later** hides that build's prompt for this visit. Nothing
  reloads automatically, and drafts are never sent by the updater.

## Access control

Tailscale membership/ACLs plus a random 256-bit pairing key. The bridge enforces
an explicit Host allowlist and same-origin login/WebSocket requests. Session
cookies are HttpOnly, SameSite=Strict and Secure on the tailnet hostname.
Static assets contain no secrets; API responses and terminal output are not cached.
The WebSocket API allows only existing Herdr terminals and explicit stream actions,
not arbitrary core RPC. Separate same-origin authenticated POST endpoints launch
only Shell/OpenCode through Herdr and perform the fixed Git worktree operations.
Uploads only write to a live, allowlisted terminal's managed upload folder. Filenames
are sanitized; no arbitrary path or file-reading endpoint is exposed. Uploads are
limited to 8 MB and three concurrent requests. There is no arbitrary command or deletion API.
Creation request IDs prevent duplicate launches when the same request is retried
within ten minutes; changing a request with an already-used ID is rejected.

Unpair removes this browser's cookie and detaches its stream. To revoke every
device, remove `~/.config/herdr-pocket/pairing-key` and restart the bridge; a new
key is generated, old cookies fail, and existing viewers disconnect.

```sh
launchctl kickstart -k gui/$(id -u)/dev.herdr-pocket
```

## Implementation and checks

`core.ts`: framed transport, bounded queues, RPC timeouts, credit flow control.
Protocol source: <https://github.com/herdrdev/herdr-core/blob/master/crates/herdr-core/src/wire.rs>.
`model.ts`: read-only desktop discovery. `server.ts`: authenticated HTTP/WebSocket
bridge. `web/app.ts`: xterm.js client and PWA navigation.

`pnpm test` starts a separate hc session with scratch XDG paths, never the user's
core. It verifies real attach/input/resize/detach plus auth, origins and frame parsing.
Uses a short path under `~/.cache` because macOS socket paths allow only 103 bytes.

`pnpm test:browser` checks the live install with headless Chrome: pairing, discovery,
local + SSH watch streams, search, and phone/desktop screenshots. It never enters
Control or sends input. Requires Chrome (`CHROME_BIN` overrides its path), an open
Herdr app with local and SSH terminals, and the local pairing key. Set `POCKET_URL`
to the Tailscale HTTPS URL to check the complete tunnel. `scripts/icons.ts` renders
the bundled SVG into the checked-in PNG install icons; it is not part of the build.
`POCKET_BROWSER_TEST=1 pnpm test` also checks mobile auto-fit and rotation against
the isolated test core, plus Control defaults, clipboard/file upload, and scrolling
while typing in normal/mouse-reporting terminals. No live user terminal is resized.

Environment: `PORT`, `POCKET_HOST`, `POCKET_STATE`, `HC_BIN`, `HERDR_APP_BIN`.
No Bun runtime or Bun tooling.

## Stop / remove

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.herdr-pocket.plist
tailscale serve --https=443 off
```

Only remove that Serve mapping if it still points at Pocket. Then remove the
Pocket plist, checkout and `~/.config/herdr-pocket` if no longer wanted.
Existing Herdr terminals are unaffected.
