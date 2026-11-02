import pty from "node-pty";
import xterm from "@xterm/headless";
import type { IBufferCell } from "@xterm/headless";
import { hcBinary } from "./core";
import { clip, pad } from "./render";

export type TerminalOptions = { address: string; title: string; onSession?: (close: () => void) => void };
type Action = "picker" | "escape" | "tab" | "up" | "down" | "live";
export function toolbar(width: number): { label: string; start: number; end: number; action: Action }[] {
  const items: [string, Action][] = [["‹ Picker", "picker"], ["Esc", "escape"], ["Tab", "tab"], ["↑", "up"], ["↓", "down"], ["Live", "live"]];
  let start = 1;
  return items.flatMap(([label, action]) => {
    const size = [...label].length + 2;
    if (start + size - 1 > width) return [];
    const button = { label, start, end: start + size - 1, action }; start += size;
    return [button];
  });
}

/** Preserve byte-exact input and bracketed paste; intercept only local controls and mouse. */
export class TerminalInput {
  private pending = Buffer.alloc(0);
  private paste = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private send: (bytes: Buffer) => void, private detach: () => void,
    private mouse: (button: number, x: number, y: number, release: boolean) => void) {}
  close() { clearTimeout(this.timer); this.pending = Buffer.alloc(0); }
  feed(bytes: Buffer) {
    clearTimeout(this.timer);
    this.pending = Buffer.concat([this.pending, bytes]);
    while (this.pending.length) {
      const special = this.pending.findIndex(byte => byte === 27 || !this.paste && (byte === 28 || byte === 29));
      if (special !== 0) {
        const count = special < 0 ? this.pending.length : special;
        this.send(this.pending.subarray(0, count)); this.pending = this.pending.subarray(count); continue;
      }
      const s = this.pending.toString("latin1");
      const marker = this.paste ? "\x1b[201~" : "\x1b[200~";
      if (s.startsWith(marker)) {
        this.send(this.pending.subarray(0, marker.length));
        this.pending = this.pending.subarray(marker.length); this.paste = !this.paste; continue;
      }
      if (marker.startsWith(s) || !this.paste && /^\x1b\[<(?:\d*;?){0,3}$/.test(s)) {
        // Only bare Escape is ambiguous. Never expire a recognized paste/mouse prefix.
        if (s === "\x1b") this.timer = setTimeout(() => { const rest = this.pending; this.pending = Buffer.alloc(0); this.send(rest); }, 120);
        else if (s.length > 128) { this.send(this.pending); this.pending = Buffer.alloc(0); }
        return;
      }
      if (!this.paste) {
        const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s);
        if (mouse) {
          this.pending = this.pending.subarray(mouse[0].length);
          this.mouse(+mouse[1], +mouse[2], +mouse[3], mouse[4] === "m"); continue;
        }
        // Classic X10 mouse reporting, used by some SSH clients.
        if (s.startsWith("\x1b[M")) {
          if (this.pending.length < 6) return;
          const [b, x, y] = [...this.pending.subarray(3, 6)].map(n => n - 32);
          this.pending = this.pending.subarray(6); this.mouse(b, x, y, (b & 3) === 3); continue;
        }
        if (this.pending[0] === 0x1d || this.pending[0] === 0x1c) { this.close(); this.detach(); return; }
      }
      this.send(this.pending.subarray(0, 1)); this.pending = this.pending.subarray(1);
    }
  }
}

function style(cell: IBufferCell): string {
  const codes: number[] = [0];
  if (cell.isBold()) codes.push(1);
  if (cell.isDim()) codes.push(2);
  if (cell.isItalic()) codes.push(3);
  if (cell.isUnderline()) codes.push(4);
  if (cell.isBlink()) codes.push(5);
  if (cell.isInverse()) codes.push(7);
  if (cell.isInvisible()) codes.push(8);
  if (cell.isStrikethrough()) codes.push(9);
  for (const fg of [true, false]) {
    const value = fg ? cell.getFgColor() : cell.getBgColor();
    if (fg ? cell.isFgRGB() : cell.isBgRGB()) codes.push(fg ? 38 : 48, 2, value >> 16 & 255, value >> 8 & 255, value & 255);
    else if (fg ? cell.isFgPalette() : cell.isBgPalette()) codes.push(fg ? 38 : 48, 5, value);
  }
  return `\x1b[${codes.join(";")}m`;
}

/** Virtual terminal bounds every app repaint above Pocket's persistent controls. */
export async function attachTerminal(options: TerminalOptions): Promise<void> {
  const size = () => ({ cols: Math.max(1, process.stdout.columns || 80), rows: Math.max(1, (process.stdout.rows || 24) - 2) });
  const tooSmall = () => cols < 12 || (process.stdout.rows || 24) < 4;
  let { cols, rows } = size();
  const term = new xterm.Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true, logLevel: "off" });
  let child: pty.IPty;
  try { child = pty.spawn(hcBinary(), ["attach", options.address], { name: "xterm-256color", cols, rows, env: { ...process.env, TERM: "xterm-256color" } }); }
  catch (e) { term.dispose(); throw e; }
  let finished = false, cursorVisible = true, sgrMouse = false, scrolling = false;
  let cache: string[] = [], frame: ReturnType<typeof setTimeout> | undefined;
  let resolve!: () => void, reject!: (error: Error) => void;
  const done = new Promise<void>((r, j) => { resolve = r; reject = j; });
  const send = (data: string | Buffer) => { if (!finished) child.write(typeof data === "string" ? data : data); };
  const draw = () => {
    frame = undefined;
    if (finished || process.stdout.writableNeedDrain) return;
    if (tooSmall()) { process.stdout.write(`\x1b[?25l\x1b[H\x1b[0m${clip("Resize · ^] picker", cols)}\x1b[K`); return; }
    const buffer = term.buffer.active;
    let out = "\x1b[?25l";
    for (let y = 0; y < rows; y++) {
      const line = buffer.getLine(buffer.viewportY + y);
      let text = "", last = "";
      for (let x = 0; x < cols; x++) {
        const cell = line?.getCell(x);
        if (!cell) { text += " "; continue; }
        if (!cell.getWidth()) continue;
        const next = style(cell);
        if (next !== last) { text += next; last = next; }
        text += (cell.getChars() || " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
      }
      if (cache[y] !== text) { out += `\x1b[${y + 1};1H${text}\x1b[0m`; cache[y] = text; }
    }
    const title = pad(`${scrolling ? "History · " : ""}${options.title} · ^] picker`, cols);
    out += `\x1b[${rows + 1};1H\x1b[0;37;48;5;236m${title}\x1b[0m`;
    out += `\x1b[${rows + 2};1H\x1b[0;48;5;24m${" ".repeat(cols)}`;
    for (const button of toolbar(cols)) out += `\x1b[${rows + 2};${button.start}H\x1b[1;37;48;5;${button.action === "picker" ? 25 : 24}m ${button.label} `;
    out += "\x1b[0m";
    if (!scrolling && cursorVisible) out += `\x1b[${Math.min(rows, buffer.cursorY + 1)};${Math.min(cols, buffer.cursorX + 1)}H\x1b[?25h`;
    process.stdout.write(out);
  };
  const schedule = () => { if (!finished && !frame) frame = setTimeout(draw, 24); };
  const scroll = (delta: number) => { term.scrollLines(delta); scrolling = term.buffer.active.viewportY < term.buffer.active.baseY; cache = []; schedule(); };
  const live = () => { term.scrollToBottom(); scrolling = false; cache = []; schedule(); };
  const action = (a: Action) => {
    if (a === "picker") close();
    else if (a === "escape") send("\x1b");
    else if (a === "tab") send("\t");
    else if (a === "up") { if (term.buffer.active.type === "alternate") send("\x1b[5~"); else scroll(-Math.max(1, Math.floor(rows / 2))); }
    else if (a === "down") { if (term.buffer.active.type === "alternate") send("\x1b[6~"); else scroll(Math.max(1, Math.floor(rows / 2))); }
    else live();
  };
  const input = new TerminalInput(bytes => {
    if (!term.modes.bracketedPasteMode && (bytes.equals(Buffer.from("\x1b[200~")) || bytes.equals(Buffer.from("\x1b[201~")))) return;
    if (scrolling) live(); send(bytes);
  }, () => close(), (b, x, y, release) => {
    if (tooSmall()) return;
    if (y >= rows + 1) {
      if (!release && b === 0) {
        if (y === rows + 1) live();
        else { const button = toolbar(cols).find(k => x >= k.start && x <= k.end); if (button) action(button.action); }
      }
      return;
    }
    if (x < 1 || x > cols || y < 1) return;
    if (term.modes.mouseTrackingMode === "none" || scrolling) { if (b & 64) scroll(b & 1 ? 3 : -3); return; }
    if (sgrMouse) send(`\x1b[<${b};${x};${y}${release ? "m" : "M"}`);
    else if (x <= 223 && y <= 223) send(Buffer.from([27, 91, 77, 32 + (release ? 3 : b), x + 32, y + 32]));
  });
  const data = (bytes: Buffer) => input.feed(bytes);
  const resize = () => { ({ cols, rows } = size()); term.resize(cols, rows); child.resize(cols, rows); cache = []; schedule(); };
  const close = () => finish();
  function finish(error?: Error) {
    if (finished) return;
    finished = true; clearTimeout(frame); input.close();
    process.stdin.removeListener("data", data); process.stdin.pause();
    process.stdout.removeListener("resize", resize); process.stdout.removeListener("drain", schedule);
    process.removeListener("SIGTERM", close); process.removeListener("SIGHUP", close);
    process.stdin.removeListener("end", close);
    subscription.dispose(); exit.dispose();
    // Kill only this hc attachment client. Core owns the actual program.
    try { child.kill(); } catch {}
    term.dispose();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?7h\x1b[0m\x1b[?25h\x1b[?1049l");
    if (error) reject(error); else resolve();
  }
  term.parser.registerCsiHandler({ prefix: "?", final: "h" }, params => { if (params.includes(25)) cursorVisible = true; if (params.includes(1006)) sgrMouse = true; return false; });
  term.parser.registerCsiHandler({ prefix: "?", final: "l" }, params => { if (params.includes(25)) cursorVisible = false; if (params.includes(1006)) sgrMouse = false; return false; });
  term.onData(send);
  let queued = 0;
  const subscription = child.onData(bytes => {
    if (finished) return;
    queued += bytes.length;
    if (queued > 256 * 1024) child.pause();
    term.write(bytes, () => {
      queued -= bytes.length;
      if (!finished && queued < 64 * 1024) child.resume();
      schedule();
    });
  });
  const exit = child.onExit(({ exitCode, signal }) => {
    if (finished) return;
    finish(exitCode || signal ? new Error(`Attach ended (${signal ? `signal ${signal}` : `exit ${exitCode}`}) · ${options.address}`) : undefined);
  });
  process.stdout.write("\x1b[?1049h\x1b[2J\x1b[?7l\x1b[?1000h\x1b[?1006h\x1b[?2004h");
  process.stdin.setRawMode(true); process.stdin.on("data", data); process.stdin.resume();
  process.stdout.on("resize", resize); process.stdout.on("drain", schedule);
  process.on("SIGTERM", close); process.on("SIGHUP", close); process.stdin.on("end", close);
  options.onSession?.(close); schedule();
  await done;
}
