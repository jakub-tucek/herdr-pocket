import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Backend, type Launch } from "./backend";
import { Input, Line, type Key } from "./input";
import { clip, pad, promptLine, rowLine, rows, selectable, type Row } from "./render";
import { spaceTerminals, type Space, type World } from "./model";
import { hcBinary } from "./core";

class Cancelled extends Error {}
type Prompt = { label: string; line: Line; resolve: (text: string) => void; reject: (e: Error) => void };
export class Tui {
  private world: World = { spaces: [], terminals: [], machines: [] };
  private scope?: string;
  private selected?: string;
  private top = 0;
  private query = "";
  private message = "";
  private prompt?: Prompt;
  private choices?: { label: string; items: string[]; index: number; top: number; resolve: (n: number) => void; reject: (e: Error) => void };
  private busy = false;
  private attached = false;
  private stopped = false;
  private loading = false;
  private help = false;
  private pressed?: string;
  private timer?: ReturnType<typeof setInterval>;
  private child?: ReturnType<typeof spawn>;
  private done!: () => void;
  private input = new Input(key => void this.key(key));
  private data = (bytes: Buffer) => this.input.feed(bytes);
  private resize = () => this.draw();
  private state = join(process.env.XDG_STATE_HOME || `${homedir()}/.local/state`, "herdr-pocket-tui", "view.json");
  constructor(private backend: Backend) {}
  async run() {
    const finished = new Promise<void>(resolve => { this.done = resolve; });
    try {
      const saved = JSON.parse(await readFile(this.state, "utf8"));
      if (typeof saved.scope === "string") this.scope = saved.scope;
      if (typeof saved.selected === "string") this.selected = saved.selected;
    } catch {}
    process.stdout.on("resize", this.resize);
    process.on("SIGTERM", () => this.quit()); process.on("SIGHUP", () => this.quit());
    process.on("SIGINT", () => { if (!this.attached) this.quit(); });
    process.stdin.on("end", () => this.quit());
    this.enter();
    await this.refresh();
    if (!this.stopped) this.timer = setInterval(() => { if (!this.attached && !this.busy && !this.prompt && !this.choices) void this.refresh(); }, 3000);
    await finished;
  }
  private enter() {
    if (this.stopped) return;
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?2004h");
    process.stdin.setRawMode(true); process.stdin.on("data", this.data); process.stdin.resume(); this.draw();
  }
  private leave() {
    this.input.clear(); process.stdin.removeListener("data", this.data); process.stdin.pause();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l");
  }
  private currentRows() { return rows(this.world, this.scope, this.query); }
  private active(): Row | undefined { return this.currentRows().find(r => r.id === this.selected); }
  private move(delta: number) {
    const choices = this.currentRows().filter(selectable);
    if (!choices.length) return;
    const at = choices.findIndex(r => r.id === this.selected);
    this.selected = choices[Math.max(0, Math.min(choices.length - 1, (at < 0 ? 0 : at) + delta))].id;
    this.draw();
  }
  private async refresh() {
    if (this.loading || this.stopped || this.attached) return;
    this.loading = true;
    try {
      this.world = await this.backend.world();
      if (this.scope && !this.world.spaces.some(s => s.id === this.scope)) this.scope = undefined;
      const list = this.currentRows();
      if (!list.some(r => r.id === this.selected && selectable(r))) this.selected = list.find(selectable)?.id;
    } catch (e: any) { this.message = e.message; }
    finally { this.loading = false; this.draw(); }
  }
  private draw() {
    if (this.attached || this.stopped) return;
    const width = Math.max(12, process.stdout.columns || 80), height = Math.max(6, process.stdout.rows || 24), body = height - 3;
    const title = this.scope ? this.world.spaces.find(s => s.id === this.scope)?.name || "Spaces" : "Pocket";
    const screen = [`\x1b[1m${pad(title, width)}\x1b[0m`, ""];
    if (this.help) {
      screen.push(...["↑/↓ or j/k   move", "Enter / tap  open", "Esc / h      spaces", "/            search", "n            new session", "w            worktree", "r            refresh", "q            quit", "", "In a terminal:", "Ctrl+\\       return here", "", "Sessions keep running."].slice(0, body).map(s => clip(s, width)));
    } else if (this.choices) {
      const c = this.choices;
      if (c.index < c.top) c.top = c.index;
      if (c.index >= c.top + body) c.top = c.index - body + 1;
      screen.push(...c.items.slice(c.top, c.top + body).map((text, index) => rowLine({ id: String(index), label: text, kind: "terminal" }, index + c.top === c.index, width)));
      screen[0] = `\x1b[1m${pad(this.choices.label, width)}\x1b[0m`;
    } else {
      const list = this.currentRows(), index = list.findIndex(r => r.id === this.selected);
      if (index < this.top) this.top = Math.max(0, index);
      if (index >= this.top + body) this.top = index - body + 1;
      this.top = Math.max(0, Math.min(this.top, Math.max(0, list.length - body)));
      screen.push(...list.slice(this.top, this.top + body).map(row => rowLine(row, row.id === this.selected, width)));
      if (!list.length) screen.push(clip(this.loading ? "Loading…" : "No sessions", width));
    }
    while (screen.length < height - 1) screen.push("");
    screen.length = height - 1;
    const footer = this.prompt ? `${this.prompt.label}: ${this.prompt.line.text}` : this.busy ? "…" : this.message || (this.query ? `/ ${this.query}` : "↵ open  / find  n new  ? keys");
    screen.push(this.prompt ? promptLine(this.prompt.label, this.prompt.line.value, this.prompt.line.cursor, width) : `\x1b[90m${pad(footer, width)}\x1b[0m`);
    process.stdout.write("\x1b[H" + screen.map(line => line + "\x1b[K").join("\r\n") + "\x1b[J");
  }
  private ask(label: string, value = "") {
    return new Promise<string>((resolve, reject) => { this.prompt = { label, line: new Line(value), resolve, reject }; this.draw(); });
  }
  private choose(label: string, items: string[]) {
    return new Promise<number>((resolve, reject) => { this.choices = { label, items, index: 0, top: 0, resolve, reject }; this.draw(); });
  }
  private async attach(address: string) {
    if (this.attached || this.stopped) return;
    this.attached = true;
    await this.backend.seen(address).catch(() => {});
    this.leave();
    await new Promise<void>(resolve => {
      this.child = spawn(hcBinary(), ["attach", address], { stdio: "inherit", env: process.env });
      this.child.on("error", e => { this.message = e.message; resolve(); });
      this.child.on("exit", code => { if (code) this.message = `Attach ended (${code})`; resolve(); });
    });
    this.child = undefined; this.attached = false;
    if (!this.stopped) { this.enter(); await this.refresh(); }
  }
  private async open(row: Row) {
    if (row.kind === "space" && row.space) {
      if (!row.space.online) throw new Error("Machine offline");
      const live = row.space.tabs.flatMap(t => t.panes).filter(p => p.terminal?.state === "live");
      this.scope = row.space.id; this.top = 0; this.selected = undefined;
      if (live.length === 1 && row.space.tabs.length === 1) { this.selected = live[0].id; await this.attach(live[0].address!); }
      else { this.selected = this.currentRows().find(selectable)?.id; this.draw(); }
    } else if (row.address) await this.attach(row.address);
  }
  private async create(worktree = false) {
    const current = this.world.spaces.find(s => s.id === this.scope) || this.active()?.space;
    let machine = current?.machine || "";
    if (!current) {
      const available = this.world.machines.filter(m => m.state === "connected");
      machine = available[await this.choose("Machine", available.map(m => m.name || "Mac"))].name;
    }
    const program = (await this.choose("Program", ["OpenCode", "Shell"])) === 0 ? "opencode" : "shell";
    let folder = current?.folder || "~", space = current?.id;
    if (worktree) {
      const repo = await this.ask("Repo", folder);
      const checkouts = await this.backend.worktrees(repo, machine);
      const choice = await this.choose("Worktree", ["New branch", ...checkouts.map(c => c.branch || c.path)]);
      if (choice === 0) {
        const branch = await this.ask("Branch");
        const base = await this.ask("From", "HEAD");
        folder = await this.backend.newWorktree(repo, branch, base, machine);
        space = undefined;
      } else {
        folder = checkouts[choice - 1].path;
        space = this.world.spaces.find(s => s.machine === machine && (s.folder === folder || s.folder.startsWith(folder + "/")))?.id;
      }
    } else {
      if (current) {
        const place = await this.choose("Where", ["New tab", "New space"]);
        if (place === 1) space = undefined;
      }
      folder = await this.ask("Folder", folder);
    }
    const name = await this.ask("Name");
    this.message = "Creating…"; this.draw();
    let created;
    try { created = await this.backend.launch({ machine, space, folder, name, program }); }
    catch (e: any) { throw new Error(worktree ? `${e.message}; checkout kept: ${folder}` : e.message); }
    this.scope = created.space; this.message = "";
    await this.refresh();
    this.selected = this.currentRows().find(r => r.address === created.address)?.id;
    await this.attach(created.address);
  }
  private async key(key: Key) {
    if (this.attached || this.stopped) return;
    if (this.prompt) {
      const p = this.prompt;
      if (key.name === "escape" || key.name === "cancel") { this.prompt = undefined; p.reject(new Cancelled()); }
      else if (key.name === "enter") { this.prompt = undefined; p.resolve(p.line.text.trim()); }
      else p.line.key(key);
      this.draw(); return;
    }
    if (this.choices) {
      const c = this.choices;
      if (key.name === "escape" || key.name === "cancel") { this.choices = undefined; c.reject(new Cancelled()); }
      if (key.name === "up" || key.text === "k") c.index = Math.max(0, c.index - 1);
      if (key.name === "down" || key.text === "j") c.index = Math.min(c.items.length - 1, c.index + 1);
      if (key.name === "pageup") c.index = Math.max(0, c.index - 8);
      if (key.name === "pagedown") c.index = Math.min(c.items.length - 1, c.index + 8);
      if (key.mouse && key.mouse.button & 64) c.index = Math.max(0, Math.min(c.items.length - 1, c.index + (key.mouse.button & 1 ? 1 : -1)));
      if (key.name === "enter") { this.choices = undefined; c.resolve(c.index); }
      if (key.mouse && !key.mouse.release && key.mouse.button === 0) {
        const index = c.top + key.mouse.y - 3;
        if (index >= 0 && index < c.items.length) { this.choices = undefined; c.resolve(index); }
      }
      this.draw(); return;
    }
    if (this.busy) return;
    this.message = "";
    if (this.help) { this.help = false; this.draw(); return; }
    if (key.name === "up" || key.text === "k") { this.move(-1); return; }
    if (key.name === "down" || key.text === "j") { this.move(1); return; }
    if (key.name === "pageup") { this.move(-8); return; }
    if (key.name === "pagedown") { this.move(8); return; }
    if (key.name === "mouse" && key.mouse) {
      if (key.mouse.button & 64) { this.move(key.mouse.button & 1 ? 1 : -1); return; }
      const row = this.currentRows()[this.top + key.mouse.y - 3];
      if (row && selectable(row)) {
        this.selected = row.id;
        if (key.mouse.release && this.pressed === row.id) key = { name: "enter" };
        else { this.pressed = row.id; this.draw(); return; }
      } else return;
    }
    if (key.name === "cancel" || key.text === "q") { this.quit(); return; }
    if (key.name === "escape" || key.name === "left" || key.text === "h") {
      if (this.query) this.query = "";
      else if (this.scope) { this.selected = this.scope; this.scope = undefined; this.top = 0; }
      this.draw(); return;
    }
    if (key.text === "?") { this.help = true; this.draw(); return; }
    this.busy = true;
    try {
      if (key.text === "/") { this.query = await this.ask("Find", this.query); this.selected = this.currentRows().find(selectable)?.id; }
      else if (key.text === "n") await this.create();
      else if (key.text === "w") await this.create(true);
      else if (key.text === "r") await this.refresh();
      else if ((key.name === "enter" || key.name === "right" || key.text === "l") && this.active()) await this.open(this.active()!);
    } catch (e: any) { if (!(e instanceof Cancelled)) this.message = e.message; }
    finally { this.busy = false; this.draw(); }
  }
  private quit() {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.timer); this.child?.kill(); this.leave(); this.backend.close();
    process.stdout.removeListener("resize", this.resize);
    void mkdir(dirname(this.state), { recursive: true, mode: 0o700 }).then(() => writeFile(this.state, JSON.stringify({ scope: this.scope, selected: this.selected }), { mode: 0o600 })).catch(() => {});
    this.done?.();
  }
}
