import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { World, Pane } from "../model";
import { watchUpdates } from "./updates";
import { controlInput, pasteInput } from "./typing";
import { readRoute, routeUrl } from "./navigation";
import { sessionControls } from "./sessions";
import { fileControls } from "./files";
import { touchScrolling } from "./touch";

function el<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
const notice = (text = "") => { el("notice").textContent = text; el("notice").hidden = !text; };
const term = new Terminal({
  fontSize: matchMedia("(max-width:700px)").matches ? 12 : 13,
  fontFamily: 'Menlo, Consolas, "Liberation Mono", monospace',
  theme: { background: "#17161e", foreground: "#e4dfec", cursor: "#c4abea" },
  scrollback: 5000, cursorBlink: false, disableStdin: true, allowProposedApi: false,
});
const fit = new FitAddon(); term.loadAddon(fit);
let opened = false, socket: WebSocket | undefined, world: World = { spaces: [] };
function preferControl() { return localStorage.getItem("inputMode") !== "watch"; }
let selected: string | undefined, controlling = preferControl(), ready = false, paired = false;
let fitting = localStorage.getItem("fitTerminal") === null ? matchMedia("(max-width:700px)").matches : localStorage.getItem("fitTerminal") === "1";
let sentGrid = "";
let directInput = true, ctrlArmed = false, shortcuts = false;
let scrollInput = false;
const expandedSpaces = new Set<string>();
const expandedHelpers = new Set<string>();
let reconnect: ReturnType<typeof setTimeout> | undefined, refreshing = false;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let navigationPending = true;
const modeButton = el<HTMLButtonElement>("mode");
const fitButton = el<HTMLButtonElement>("fit");
const keyboard = el<HTMLButtonElement>("keyboard");
const terminalHost = el("terminal");
const message = el<HTMLTextAreaElement>("message");
const ctrlButton = el<HTMLButtonElement>("ctrl");
const sendButton = el<HTMLButtonElement>("send-message");
const shortcutsButton = el<HTMLButtonElement>("show-keys");
const directShortcuts = el<HTMLButtonElement>("direct-shortcuts");
const optionsMenu = el<HTMLDetailsElement>("terminal-menu");
const overviewMenu = el<HTMLDetailsElement>("overview-menu");
let updateFiles = () => {};
const pendingFiles = new Map<string, string[]>();
function pasteFiles() {
  if (!selected || !ready || !controlling) return;
  const files = pendingFiles.get(selected);
  if (!files?.length) return;
  const text = files.join("");
  if (directInput) send({ type: "input", text: pasteInput(text, term.modes.bracketedPasteMode) });
  else { message.value += text; updateTyping(); }
  pendingFiles.delete(selected);
}
function growComposer() {
  if (message.hidden || el("compose").hidden) return;
  message.style.height = "0px";
  const height = Math.max(36, Math.min(message.scrollHeight + 2, 100));
  message.style.height = `${height}px`;
  message.style.overflowY = message.scrollHeight > 98 ? "auto" : "hidden";
}
function updateTyping() {
  const enabled = ready && controlling;
  term.options.disableStdin = !enabled || !directInput;
  if (term.textarea) { term.textarea.readOnly = !enabled || !directInput; term.textarea.tabIndex = directInput ? 0 : -1; }
  keyboard.textContent = directInput ? "Compose" : "Terminal";
  keyboard.setAttribute("aria-pressed", String(directInput));
  keyboard.title = directInput ? "Switch to message composer" : "Switch to direct terminal typing";
  el("compose").hidden = !enabled || directInput;
  const typing = document.activeElement === message || directInput && document.activeElement === term.textarea;
  document.body.classList.toggle("typing", enabled && typing);
  el("keys").hidden = !enabled || !typing || !shortcuts;
  directShortcuts.hidden = !enabled || !directInput;
  directShortcuts.setAttribute("aria-pressed", String(shortcuts));
  shortcutsButton.setAttribute("aria-pressed", String(shortcuts));
  ctrlButton.setAttribute("aria-pressed", String(ctrlArmed));
  sendButton.disabled = !enabled || !message.value.trim();
  updateFiles();
  growComposer();
}
function resetTyping() { directInput = true; ctrlArmed = false; shortcuts = false; }
type ReloadView = { route?: string; terminal?: string; viewing: boolean; fitting: boolean; search: string; spaces: string[]; helpers: string[]; scroll: number; draft: string };
let reloadView: ReloadView | undefined;
try {
  const value = JSON.parse(sessionStorage.getItem("pocketReload") || "null");
  if (value && typeof value === "object" && typeof value.search === "string" && typeof value.draft === "string"
    && Array.isArray(value.spaces) && value.spaces.every((s: unknown) => typeof s === "string")
    && Array.isArray(value.helpers) && value.helpers.every((s: unknown) => typeof s === "string")) reloadView = value;
} catch { /* A stale or malformed saved view should not block startup. */ }

function restorePresentation() {
  if (!reloadView) return;
  const saved = reloadView; reloadView = undefined;
  sessionStorage.removeItem("pocketReload");
  // Only presentation is stored here. A deep link always wins over a saved view.
  if (saved.route && saved.route !== location.pathname + location.search) return;
  // Upgrade from builds that saved a terminal only for the update button.
  if (!saved.route && saved.viewing && saved.terminal && !readRoute(location.href).terminal) {
    history.replaceState(null, "", routeUrl(location.href, { terminal: saved.terminal, query: saved.search }));
  }
  if (typeof saved.fitting === "boolean") fitting = saved.fitting;
  for (const id of saved.spaces) expandedSpaces.add(id);
  for (const id of saved.helpers) expandedHelpers.add(id);
  el<HTMLTextAreaElement>("message").value = saved.draft;
  render();
  el("spaces").scrollTop = Number.isFinite(saved.scroll) ? saved.scroll : 0;
}

type Navigation = "push" | "replace" | "none";
function writeRoute(terminal: string | undefined, how: Navigation) {
  if (how === "none") return;
  const url = routeUrl(location.href, { terminal, query: el<HTMLInputElement>("search").value });
  if (url !== location.href) history[how === "push" ? "pushState" : "replaceState"](null, "", url);
}
function showOverview(how: Navigation = "push") {
  selected = undefined; controlling = false; resetTyping(); disconnect();
  document.body.classList.remove("viewing");
  optionsMenu.open = false;
  el("title").textContent = "Pick a terminal";
  if (opened) term.reset();
  notice(); render(); writeRoute(undefined, how);
}
function applyRoute() {
  if (!paired || !navigationPending) return;
  navigationPending = false;
  const route = readRoute(location.href);
  el<HTMLInputElement>("search").value = route.query;
  if (!route.terminal) { showOverview("none"); return; }
  for (const space of world.spaces) for (const tab of space.tabs) for (const pane of tab.terminals) {
    if (pane.terminal !== route.terminal && !pane.sub_agents.includes(route.terminal)) continue;
    expandedSpaces.add(space.id);
    if (pane.terminal !== route.terminal) expandedHelpers.add(pane.terminal);
    select(route.terminal, `${space.name} / ${tab.name}`, "none");
    return;
  }
  showOverview("replace");
  notice("Terminal closed.");
}

async function api(path: string, body?: object) {
  const response = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  if (response.status === 401) { showPair(); throw new Error("Pair this device first"); }
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Connection failed");
  return value;
}
function showPair() {
  paired = false; navigationPending = true; disconnect(); clearTimeout(refreshTimer);
  el("app").hidden = true; el("pair").hidden = false;
}
function disconnect() {
  clearTimeout(reconnect);
  ready = false;
  if (socket) { socket.onclose = null; socket.close(); socket = undefined; }
  term.options.disableStdin = true;
  updateMode();
}
function send(value: object) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); }
function updateMode() {
  el("app").dataset.terminalState = ready ? controlling ? "control" : "watch" : selected ? "connecting" : "idle";
  modeButton.disabled = !selected;
  modeButton.textContent = selected && controlling ? "Watch" : "Control";
  modeButton.classList.toggle("active", !!selected && controlling);
  fitButton.textContent = fitting ? "Actual size" : "Fit screen";
  fitButton.setAttribute("aria-pressed", String(fitting));
  fitButton.disabled = controlling;
  keyboard.disabled = !ready || !controlling;
  updateTyping();
}
function fitControl() {
  if (!opened || !(controlling || fitting) || !ready || el("app").hidden) return;
  terminalHost.style.width = "100%"; terminalHost.style.height = "100%";
  fit.fit();
  const grid = `${term.cols}x${term.rows}`;
  if (grid !== sentGrid) { sentGrid = grid; send({ type: "resize", cols: term.cols, rows: term.rows }); }
}
function setGrid(cols: number, rows: number) {
  if (controlling || fitting || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) return;
  term.resize(cols, rows);
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  if (screen) { terminalHost.style.width = `${screen.offsetWidth}px`; terminalHost.style.height = `${screen.offsetHeight}px`; }
}
function attach() {
  disconnect();
  sentGrid = "";
  if (!selected || !paired || document.hidden) return;
  document.body.classList.add("viewing");
  if (!opened) {
    term.open(terminalHost); opened = true;
    touchScrolling(term, el("terminal-scroll"), () => ready && controlling, () => ready && controlling && directInput, (node, event) => {
      const disabled = term.options.disableStdin;
      scrollInput = true; term.options.disableStdin = !ready || !controlling;
      try { node.dispatchEvent(event); }
      finally { scrollInput = false; term.options.disableStdin = disabled; }
    });
  }
  term.reset();
  terminalHost.style.width = "100%"; terminalHost.style.height = "100%";
  fit.fit();
  notice();
  const query = new URLSearchParams({ id: selected, control: controlling ? "1" : "0", fit: fitting ? "1" : "0", cols: String(term.cols), rows: String(term.rows) });
  const ws = socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/terminal?${query}`);
  ws.binaryType = "arraybuffer";
  ws.onmessage = event => {
    if (ws !== socket) return;
    if (typeof event.data !== "string") {
      const bytes = new Uint8Array(event.data);
      term.write(bytes, () => {
        if (ws === socket && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "credit", bytes: bytes.length }));
          pasteFiles();
        }
      });
      return;
    }
    const m = JSON.parse(event.data);
    if (m.type === "ready") {
      ready = true;
      if (controlling || fitting) fitControl(); else setGrid(m.cols, m.rows);
      updateMode();
      notice();
    } else if (m.type === "size") setGrid(m.cols, m.rows);
    else if (m.type === "error") notice(m.message);
  };
  ws.onclose = event => {
    if (ws !== socket) return;
    ready = false; controlling = false; resetTyping(); updateMode();
    notice("Reconnecting…");
    reconnect = setTimeout(() => { controlling = preferControl(); void refresh(); attach(); }, 2500);
  };
  ws.onerror = () => notice("Connection failed.");
}
function select(address: string, title: string, how: Navigation = "push") {
  overviewMenu.open = false;
  selected = address; controlling = preferControl(); resetTyping();
  el("title").textContent = title;
  writeRoute(address, how);
  render(); attach();
}
function text(tag: string, content: string, className = "") {
  const node = document.createElement(tag); node.textContent = content; node.className = className; return node;
}
function terminalButton(pane: Pane, address: string, title: string, child = false) {
  const button = document.createElement("button");
  button.className = `session${selected === address ? " selected" : ""}${child ? " child" : ""}`;
  const dot = text("span", "", `dot ${child ? "" : pane.status || ""}`); dot.title = child ? "Sub-agent" : pane.status || "Shell";
  button.append(dot, text("span", child ? "↳ Sub-agent" : pane.name || pane.app || "Shell", "label"), text("span", address, "address"));
  button.addEventListener("click", () => select(address, title));
  return button;
}
function render() {
  const nav = el("spaces"), query = el<HTMLInputElement>("search").value.toLowerCase();
  const content = document.createDocumentFragment();
  let lastMachine: string | undefined;
  for (const space of world.spaces) {
    const match = `${space.name} ${space.machine || "Mac"} ${space.tabs.map(t => `${t.name} ${t.terminals.map(p => `${p.app} ${p.name} ${p.terminal}`).join(" ")}`).join(" ")}`.toLowerCase();
    if (!match.includes(query)) continue;
    const machine = space.machine || "Mac";
    if (machine !== lastMachine) { content.append(text("div", machine, "machine")); lastMachine = machine; }
    const group = text("section", "", "space");
    const panes = space.tabs.flatMap(t => t.terminals);
    const expanded = expandedSpaces.has(space.id) || !!query;
    const rank = ["blocked", "error", "done", "working", "idle"];
    const status = rank.find(status => panes.some(p => p.status === status)) || "";
    const heading = document.createElement("button");
    heading.className = "space-name";
    heading.title = space.name;
    heading.setAttribute("aria-expanded", String(expanded));
    const dot = text("span", "", `dot ${status}`); dot.title = status || "Shell";
    const count = text("span", String(panes.length), "space-count"); count.title = `${panes.length} terminals in ${space.tabs.length} tabs`;
    heading.append(text("span", expanded ? "▾" : "▸", "chevron"), dot, text("span", space.name, "space-label"), count);
    heading.addEventListener("click", () => {
      if (expandedSpaces.has(space.id)) expandedSpaces.delete(space.id); else expandedSpaces.add(space.id);
      render();
    });
    group.append(heading);
    content.append(group);
    if (!expanded) continue;
    for (const tab of space.tabs) {
      if (space.tabs.length > 1 || tab.name !== "1") group.append(text("div", tab.name, "tab-name"));
      if (!tab.terminals.length) group.append(text("div", "Desktop only", "unsupported"));
      for (const pane of tab.terminals) {
        const title = `${space.name} / ${tab.name}`;
        group.append(terminalButton(pane, pane.terminal, title));
        if (pane.sub_agents.length) {
          const helpers = document.createElement("button");
          const showing = expandedHelpers.has(pane.terminal);
          helpers.className = "helpers-toggle";
          helpers.textContent = `${showing ? "▾" : "▸"} ${pane.sub_agents.length} sub-agents`;
          helpers.setAttribute("aria-expanded", String(showing));
          helpers.addEventListener("click", () => {
            if (showing) expandedHelpers.delete(pane.terminal); else expandedHelpers.add(pane.terminal);
            render();
          });
          group.append(helpers);
          if (showing) for (const child of pane.sub_agents) group.append(terminalButton(pane, child, `${title} / ${child}`, true));
        }
      }
    }
  }
  if (!world.spaces.length) content.append(text("p", "No open spaces."));
  nav.replaceChildren(content);
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const next = await api("/api/world") as World;
    world = next; paired = true; el("pair").hidden = true; el("app").hidden = false;
    el("connection").textContent = ""; el("connection").hidden = true; el("connection").className = "";
    render();
    restorePresentation();
    applyRoute();
    if (selected && !world.spaces.some(s => s.tabs.some(t => t.terminals.some(p => p.terminal === selected || p.sub_agents.includes(selected!))))) {
      showOverview("replace");
      notice("Terminal closed.");
    }
  } catch (e: any) { el("connection").textContent = e.message; el("connection").hidden = false; el("connection").className = "error"; }
  finally { refreshing = false; }
}
async function tick() {
  await refresh();
  if (paired) refreshTimer = setTimeout(tick, document.hidden ? 15000 : 4000);
}
term.onData(data => {
  if (!ready || !controlling || !(directInput || scrollInput)) return;
  if (scrollInput) { send({ type: "input", text: data }); return; }
  const text = ctrlArmed ? controlInput(data) ?? data : data;
  ctrlArmed = false; updateTyping();
  send({ type: "input", text });
});
el("pair-form").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    await api("/api/login", { key: el<HTMLInputElement>("key").value.trim() });
    el<HTMLInputElement>("key").value = ""; el("pair-error").textContent = "";
    clearTimeout(refreshTimer); await tick();
  } catch (e: any) { el("pair-error").textContent = e.message; }
});
el("logout").addEventListener("click", async () => {
  overviewMenu.open = false;
  if (!confirm("Unpair this device?")) return;
  await api("/api/logout", {}); sessionStorage.removeItem("pocketReload"); reloadView = undefined; showPair();
});
el("refresh").addEventListener("click", () => { overviewMenu.open = false; void refresh(); });
el("search").addEventListener("input", () => { render(); writeRoute(selected, "replace"); });
el("back").addEventListener("click", () => showOverview());
window.addEventListener("popstate", () => { navigationPending = true; optionsMenu.open = false; applyRoute(); });
window.addEventListener("pageshow", event => { if (event.persisted) { navigationPending = true; void refresh(); } });
modeButton.addEventListener("click", () => {
  controlling = !controlling;
  localStorage.setItem("inputMode", controlling ? "control" : "watch");
  resetTyping();
  attach();
});
fitButton.addEventListener("click", () => {
  optionsMenu.open = false;
  fitting = !fitting;
  localStorage.setItem("fitTerminal", fitting ? "1" : "0");
  updateMode();
  if (selected && document.body.classList.contains("viewing")) attach();
});
keyboard.addEventListener("click", () => {
  if (!ready || !controlling) return;
  optionsMenu.open = false;
  directInput = !directInput; ctrlArmed = false; updateTyping();
  if (directInput) term.focus(); else message.focus();
});
document.addEventListener("pointerdown", event => {
  if (!optionsMenu.contains(event.target as Node)) optionsMenu.open = false;
  if (!overviewMenu.contains(event.target as Node)) overviewMenu.open = false;
});
document.addEventListener("keydown", event => { if (event.key === "Escape") { optionsMenu.open = false; overviewMenu.open = false; } });
function toggleShortcuts() {
  shortcuts = !shortcuts;
  if (!shortcuts) ctrlArmed = false;
  if (directInput) term.focus(); else message.focus();
  updateTyping();
}
for (const button of [shortcutsButton, directShortcuts]) {
  button.addEventListener("pointerdown", event => event.preventDefault());
  button.addEventListener("click", toggleShortcuts);
}
el("keys").addEventListener("pointerdown", event => event.preventDefault());
el("keys").addEventListener("click", event => {
  if ((event.target as HTMLElement).closest("#ctrl")) {
    ctrlArmed = !ctrlArmed; updateTyping(); return;
  }
  const key = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-key]")?.dataset.key;
  if (key && ready && controlling) send({ type: "input", text: JSON.parse(`"${key}"`) });
});
message.addEventListener("input", updateTyping);
message.addEventListener("beforeinput", event => {
  if (!ctrlArmed || !ready || !controlling || event.isComposing || !event.data) return;
  const text = controlInput(event.data);
  if (text === undefined) return;
  event.preventDefault(); ctrlArmed = false; updateTyping(); send({ type: "input", text });
});
message.addEventListener("keydown", event => {
  if (event.isComposing) return;
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); el<HTMLFormElement>("compose").requestSubmit(); }
});
document.addEventListener("focusin", updateTyping);
document.addEventListener("focusout", () => requestAnimationFrame(() => {
  if (document.activeElement !== message && document.activeElement !== term.textarea) ctrlArmed = false;
  updateTyping();
}));
// Keep focus (and the mobile keyboard) while pressing Send.
sendButton.addEventListener("pointerdown", event => event.preventDefault());
el("compose").addEventListener("submit", event => {
  event.preventDefault();
  if (!ready || !controlling || directInput || !message.value.trim()) return;
  if (new TextEncoder().encode(message.value).length > 16000) { notice("Message too long (16 KB maximum)."); return; }
  // Composer input is explicit; direct keyboard input stays locked by default.
  const target = socket;
  send({ type: "input", text: pasteInput(message.value, term.modes.bracketedPasteMode) });
  setTimeout(() => { if (target === socket && ready && controlling) send({ type: "input", text: "\r" }); }, 100);
  message.value = "";
  ctrlArmed = false; updateTyping();
});
new ResizeObserver(() => fitControl()).observe(el("terminal-scroll"));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { disconnect(); controlling = false; resetTyping(); updateMode(); }
  else { void refresh(); if (document.body.classList.contains("viewing")) { controlling = preferControl(); attach(); } }
});
function viewport() {
  const height = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--visual-height", `${height}px`);
  el("app").style.height = `${height}px`;
  // Viewport reflows (Safari chrome, rotation, keyboard animation) must not
  // blur the terminal: the user can keep typing while scrolling the transcript.
  updateTyping();
}
window.visualViewport?.addEventListener("resize", viewport); viewport();
setInterval(() => send({ type: "ping" }), 20000);
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
function savePresentation() {
  if (!paired) return;
  sessionStorage.setItem("pocketReload", JSON.stringify({
    route: location.pathname + location.search,
    terminal: selected, viewing: document.body.classList.contains("viewing"), fitting,
    search: el<HTMLInputElement>("search").value, spaces: [...expandedSpaces], helpers: [...expandedHelpers],
    scroll: el("spaces").scrollTop, draft: el<HTMLTextAreaElement>("message").value,
  } satisfies ReloadView));
}
watchUpdates(savePresentation);
updateFiles = fileControls(() => selected && ready && controlling ? selected : undefined, (terminal, text) => {
  pendingFiles.set(terminal, [...pendingFiles.get(terminal) || [], text]);
  pasteFiles();
  if (terminal !== selected) notice("Upload ready in its original session.");
}, notice);
updateFiles();
sessionControls(api, () => selected, async created => {
  world = await api("/api/world");
  const space = world.spaces.find(s => s.tabs.some(t => t.terminals.some(p => p.terminal === created.terminal)));
  if (space) expandedSpaces.add(space.id);
  const tab = space?.tabs.find(t => t.terminals.some(p => p.terminal === created.terminal));
  select(created.terminal, space ? `${space.name} / ${tab?.name || "1"}` : "New session");
});
window.addEventListener("pagehide", () => { try { savePresentation(); } catch { /* Private-mode storage can be unavailable; URL navigation still works. */ } });
// A fragment never reaches the server or access logs. Remove it immediately.
if (location.hash.startsWith("#pair=")) {
  el<HTMLInputElement>("key").value = decodeURIComponent(location.hash.slice(6));
  const url = new URL(location.href); url.hash = "";
  history.replaceState(null, "", url.href);
}
await tick();
updateMode();
