import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Backend } from "./backend";
import { Input, Line, type Key } from "./input";
import { clip, pad, pickerRows, promptLine, rowLine, selectable, type PickerRepository, type Row } from "./render";
import { type World } from "./model";
import { attachTerminal } from "./terminal";

export class Tui {
  private world: World = { spaces: [], terminals: [], machines: [] };
  private repositories: PickerRepository[] = [];
  private view: "repos" | "spaces" = "repos";
  private scope?: string;
  private checkout?: string;
  private selected?: string;
  private top = 0;
  private query = "";
  private search?: Line;
  private message = "";
  private busy = false;
  private attached = false;
  private entered = false;
  private stopped = false;
  private loading = false;
  private discovering = false;
  private discovered = false;
  private help = false;
  private lastDiscovery = 0;
  private timer?: ReturnType<typeof setInterval>;
  private closeTerminal?: () => void;
  private done!: () => void;
  private input = new Input(key => void this.key(key));
  private data = (bytes: Buffer) => this.input.feed(bytes);
  private resize = () => this.draw();
  private terminate = () => this.quit();
  private interrupt = () => { if (!this.attached) this.quit(); };
  private state = join(process.env.XDG_STATE_HOME || `${homedir()}/.local/state`, "herdr-pocket-tui", "view.json");
  constructor(private backend: Backend) {}
  async run() {
    const finished = new Promise<void>(resolve => { this.done = resolve; });
    try {
      const saved = JSON.parse(await readFile(this.state, "utf8"));
      if (saved.view === "repos" || saved.view === "spaces") this.view = saved.view;
      if (typeof saved.scope === "string") this.scope = saved.scope;
      if (typeof saved.selected === "string") this.selected = saved.selected;
      if (typeof saved.checkout === "string") this.checkout = saved.checkout;
    } catch {}
    process.stdout.on("resize", this.resize);
    process.on("SIGTERM", this.terminate);
    process.on("SIGHUP", this.terminate);
    process.on("SIGINT", this.interrupt);
    process.stdin.on("end", this.terminate);
    try {
      this.enter();
      await this.refresh(true);
      if (!this.stopped) this.timer = setInterval(() => {
        if (!this.attached && !this.busy) void this.refresh(Date.now() - this.lastDiscovery >= 60_000);
      }, 2000);
      await finished;
    } finally { this.quit(); }
  }
  private enter() {
    if (this.stopped || this.entered) return;
    this.entered = true;
    process.stdout.write("\x1b[?1049h\x1b[?7l\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?2004h");
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on("data", this.data);
    process.stdin.resume();
    this.draw();
  }
  private leave() {
    if (!this.entered) return;
    this.entered = false;
    this.input.clear();
    process.stdin.removeListener("data", this.data);
    process.stdin.pause();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?7h\x1b[0m\x1b[?25h\x1b[?1049l");
  }
  private currentRows() { return pickerRows(this.world, this.repositories, this.view, this.scope, this.query, this.checkout); }
  private active() { return this.currentRows().find(row => row.id === this.selected); }
  private reconcile() {
    if (this.scope && (this.view === "spaces" ? !this.world.spaces.some(s => s.id === this.scope) : this.discovered && !this.repositories.some(r => r.id === this.scope))) {
      this.scope = undefined; this.checkout = undefined; this.top = 0;
    }
    const repo = this.repositories.find(r => r.id === this.scope);
    if (repo && this.checkout && !repo.checkouts.some(c => c.path === this.checkout)) this.checkout = undefined;
    if (this.view === "repos" && !this.discovered) return;
    const list = this.currentRows();
    if (!list.some(row => row.id === this.selected && selectable(row))) this.selected = list.find(selectable)?.id;
  }
  private move(delta: number) {
    const list = this.currentRows().filter(selectable);
    if (!list.length) return;
    const at = list.findIndex(row => row.id === this.selected);
    this.selected = list[Math.max(0, Math.min(list.length - 1, at < 0 ? 0 : at + delta))].id;
    this.draw();
  }
  private async refresh(discover = false) {
    if (this.loading || this.stopped || this.attached) return;
    this.loading = true;
    this.draw();
    try {
      const world = await this.backend.world();
      if (this.stopped) return;
      if (world.machines.some(machine => machine.state === "connected" && this.world.machines.some(old => old.name === machine.name && old.state !== "connected"))) discover = true;
      this.world = world;
      // Connectivity changes must disable launches before the next discovery.
      this.repositories = this.repositories.map(repo => ({ ...repo,
        online: repo.online && world.machines.some(m => m.name === repo.machine && m.state === "connected"),
        spaceIds: world.spaces.filter(space => space.machine === repo.machine && repo.checkouts.some(c => c.path === (space.workspaceFolder || space.folder))).map(space => space.id),
      }));
      this.reconcile();
    } catch (error) {
      this.message = this.error(error);
      this.world = { ...this.world, spaces: this.world.spaces.map(space => ({ ...space, online: false })), machines: this.world.machines.map(machine => ({ ...machine, state: "unavailable" })) };
      this.repositories = this.repositories.map(repo => ({ ...repo, online: false }));
    }
    finally { this.loading = false; this.draw(); }
    if (discover && !this.stopped && !this.attached) void this.discover();
  }
  private async discover() {
    if (this.discovering || this.stopped) return;
    this.discovering = true;
    this.lastDiscovery = Date.now();
    this.draw();
    try {
      const repositories = await this.backend.repositories(this.world);
      if (this.stopped) return;
      this.repositories = repositories.map(repo => ({ ...repo, online: repo.online && this.world.machines.some(m => m.name === repo.machine && m.state === "connected") }));
      this.discovered = true;
      this.reconcile();
    } catch (error) { this.message = this.error(error); }
    finally { this.discovering = false; this.draw(); }
  }
  private dimensions() {
    return { width: Math.max(1, process.stdout.columns || 80), height: Math.max(1, process.stdout.rows || 24) };
  }
  private visibleRows() {
    const body = Math.max(1, this.dimensions().height - 4), list = this.currentRows();
    const at = list.findIndex(row => row.id === this.selected);
    if (at >= 0 && at < this.top) this.top = at;
    if (at >= this.top + body) this.top = at - body + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, list.length - body)));
    return list.slice(this.top, this.top + body);
  }
  private shortcuts() { return this.visibleRows().filter(selectable).slice(0, 9); }
  private draw() {
    if (this.attached || this.stopped || !this.entered) return;
    const { width, height } = this.dimensions();
    if (width < 12 || height < 6) { process.stdout.write(`\x1b[H\x1b[0m${clip("Resize · q quit", width)}\x1b[K`); return; }
    const repo = this.repositories.find(r => r.id === this.scope);
    const space = this.world.spaces.find(s => s.id === this.scope);
    const title = this.scope ? `‹ ${this.view === "repos" ? repo?.name || "Repository" : space?.name || "Space"}` : "herdr pocket";
    const tabs = this.view === "repos" ? "[Repos]   Spaces" : " Repos   [Spaces]";
    const context = this.scope ? this.view === "repos" ? repo?.checkouts.find(c => c.path === (this.checkout || repo.folder))?.branch || this.checkout || repo?.folder || "" : space?.folder || "" : "tap a workspace · Tab switches view";
    const screen = [`\x1b[1m${pad(title, width)}\x1b[0m`, pad(tabs, width), `\x1b[90m${pad(context, width)}\x1b[0m`];
    if (this.help) {
      screen.push(...["↑/↓ j/k   move", "Enter / tap / 1–9   open", "Tab   repos / spaces", "Esc / h   back", "/   search (Esc clears)", "o / n   + OpenCode", "s   + Shell", "w   + Worktree", "r   rediscover repos", "q / Ctrl+C   quit", "", "Terminal: Picker / Ctrl+] / Ctrl+\\", "Sessions keep running."].slice(0, height - 4).map(text => clip(text, width)));
    } else {
      const list = this.visibleRows(), shortcuts = this.shortcuts();
      screen.push(...list.map(row => rowLine(row, row.id === this.selected, width, shortcuts.findIndex(r => r.id === row.id) + 1 || undefined)));
      if (!list.length) screen.push(clip(this.loading || this.discovering ? "Finding workspaces…" : this.query ? "No matches · Esc clears search" : this.scope ? "No sessions yet" : this.view === "repos" ? "No repos found · Spaces or r refresh" : "No spaces yet · r refresh", width));
    }
    while (screen.length < height - 1) screen.push("");
    screen.length = height - 1;
    const footer = this.message || (this.busy ? "Opening…" : this.discovering ? "Discovering repos…" : this.query ? `/ ${this.query}` : "1–9 open  / find  Tab view  ? help");
    screen.push(this.search ? promptLine("Find", this.search.value, this.search.cursor, width) : `\x1b[90m${pad(footer, width)}\x1b[0m`);
    process.stdout.write("\x1b[H" + screen.map(line => line + "\x1b[K").join("\r\n") + "\x1b[J");
  }
  private async attach(address: string, title: string) {
    if (this.attached || this.stopped) return;
    this.attached = true;
    this.leave();
    try {
      await this.backend.seen(address).catch(() => {});
      if (this.stopped) return;
      await attachTerminal({ address, title, onSession: close => {
        this.closeTerminal = close;
        if (this.stopped) close();
      } });
    } finally {
      this.closeTerminal = undefined;
      this.attached = false;
      if (!this.stopped) { this.enter(); await this.refresh(); }
    }
  }
  private async launch(action: "opencode" | "shell" | "worktree") {
    if (!this.scope) { this.message = "Choose a repository or space first"; return; }
    let created: Awaited<ReturnType<Backend["launch"]>>;
    if (this.view === "repos") {
      const repo = this.repositories.find(r => r.id === this.scope);
      if (!repo) throw new Error("Repository unavailable · r refresh");
      if (!repo.online) throw new Error("Machine offline");
      created = action === "worktree" ? await this.backend.newRepositoryWorktree(repo, "opencode") : await this.backend.launchInRepository(repo, action, repo.checkouts.find(c => c.path === this.checkout));
      if (action === "worktree") {
        if (!repo.checkouts.some(c => c.path === created.folder)) repo.checkouts.push({ path: created.folder, branch: null });
        this.checkout = created.folder;
        this.lastDiscovery = 0;
      }
    } else {
      const space = this.world.spaces.find(s => s.id === this.scope);
      if (!space) throw new Error("Space closed");
      if (!space.online) throw new Error("Machine offline");
      if (action === "worktree") throw new Error("Choose a repository for a worktree");
      created = await this.backend.launch({ machine: space.machine, space: space.id, folder: space.folder, program: action });
    }
    if (!this.stopped) await this.attach(created.address, action === "shell" ? "Shell" : "OpenCode");
  }
  private async open(row: Row) {
    if (row.kind === "repository" || row.kind === "space") {
      this.scope = row.id; this.selected = undefined; this.checkout = undefined; this.top = 0; this.query = "";
      this.reconcile(); this.draw();
    } else if (row.kind === "checkout") { this.checkout = row.path; this.draw(); }
    else if (row.action) await this.launch(row.action);
    else if (row.address) await this.attach(row.address, row.label);
  }
  private back() {
    if (this.query) this.query = "";
    else if (this.scope) { this.selected = this.scope; this.scope = undefined; this.checkout = undefined; this.top = 0; }
    this.reconcile(); this.draw();
  }
  private switchView(view: "repos" | "spaces" = this.view === "repos" ? "spaces" : "repos") {
    this.view = view;
    this.scope = undefined; this.checkout = undefined; this.selected = undefined; this.query = ""; this.top = 0;
    this.reconcile(); this.draw();
  }
  private async key(key: Key) {
    if (this.attached || this.stopped) return;
    if (key.name === "cancel" || (!this.search && key.text === "q")) { this.quit(); return; }
    if (this.dimensions().width < 12 || this.dimensions().height < 6) return;
    if (this.busy) return;
    if (this.search) {
      if (key.name === "escape") { this.search = undefined; this.query = ""; }
      else if (key.name === "enter") this.search = undefined;
      else { this.search.key(key); this.query = this.search.text; this.top = 0; }
      this.reconcile(); this.draw(); return;
    }
    if (this.help) { this.help = false; this.draw(); return; }
    if (key.name === "up" || key.text === "k") { this.move(-1); return; }
    if (key.name === "down" || key.text === "j") { this.move(1); return; }
    if (key.name === "pageup") { this.move(-8); return; }
    if (key.name === "pagedown") { this.move(8); return; }
    if (key.name === "escape" || key.name === "left" || key.text === "h") { this.back(); return; }
    if (key.name === "tab") { this.switchView(); return; }
    if (key.text === "?") { this.help = true; this.draw(); return; }
    if (key.text === "/") { this.search = new Line(this.query); this.message = ""; this.draw(); return; }
    let row: Row | undefined;
    if (key.mouse) {
      if (key.mouse.release) return;
      if (key.mouse.button & 64) { this.move(key.mouse.button & 1 ? 1 : -1); return; }
      if (key.mouse.button !== 0) return;
      if (key.mouse.y === 1 && this.scope) { this.back(); return; }
      if (key.mouse.y === 2) { this.switchView(key.mouse.x <= 8 ? "repos" : "spaces"); return; }
      row = this.visibleRows()[key.mouse.y - 4];
      if (!row || !selectable(row)) return;
    } else if (key.text && /^[1-9]$/.test(key.text)) row = this.shortcuts()[Number(key.text) - 1];
    else if (key.name === "enter" || key.name === "right" || key.text === "l") row = this.active();
    this.message = "";
    this.busy = true;
    this.draw();
    try {
      if (row && selectable(row)) { this.selected = row.id; await this.open(row); }
      else if (key.text === "r") { this.backend.invalidateRepositoryDiscovery(); await this.refresh(); await this.discover(); }
      else if (key.text === "n" || key.text === "o") await this.launch("opencode");
      else if (key.text === "s") await this.launch("shell");
      else if (key.text === "w") await this.launch("worktree");
    } catch (error) { this.message = this.error(error); }
    finally { this.busy = false; this.draw(); }
  }
  private error(error: unknown) { return error instanceof Error ? error.message : String(error); }
  private quit() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.closeTerminal?.();
    this.leave();
    this.backend.close();
    process.stdout.removeListener("resize", this.resize);
    process.removeListener("SIGTERM", this.terminate);
    process.removeListener("SIGHUP", this.terminate);
    process.removeListener("SIGINT", this.interrupt);
    process.stdin.removeListener("end", this.terminate);
    void mkdir(dirname(this.state), { recursive: true, mode: 0o700 }).then(() => writeFile(this.state, JSON.stringify({ view: this.view, scope: this.scope, checkout: this.checkout, selected: this.selected }), { mode: 0o600 })).catch(() => {});
    this.done?.();
  }
}
