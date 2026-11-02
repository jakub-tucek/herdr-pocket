import { StringDecoder } from "node:string_decoder";

export type Key = { name: string; text?: string; mouse?: { button: number; x: number; y: number; release: boolean } };
const arrows: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", "5~": "pageup", "6~": "pagedown", "3~": "delete" };
export class Input {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private escape?: ReturnType<typeof setTimeout>;
  constructor(private emit: (key: Key) => void) {}
  clear() { clearTimeout(this.escape); this.pending = ""; this.decoder = new StringDecoder("utf8"); }
  feed(bytes: Buffer) {
    clearTimeout(this.escape);
    this.pending += this.decoder.write(bytes);
    while (this.pending) {
      const s = this.pending;
      if (s.startsWith("\x1b[200~")) {
        const end = s.indexOf("\x1b[201~");
        if (end < 0) { if (s.length > 1024 * 1024) this.clear(); return; }
        this.pending = s.slice(end + 6);
        this.emit({ name: "text", text: s.slice(6, end).replace(/[\r\n\x00-\x1f\x7f]/g, "") }); continue;
      }
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s);
      if (mouse) {
        this.pending = s.slice(mouse[0].length);
        this.emit({ name: "mouse", mouse: { button: +mouse[1], x: +mouse[2], y: +mouse[3], release: mouse[4] === "m" } }); continue;
      }
      const csi = /^\x1b\[([0-9;]*[A-Za-z~])/.exec(s);
      if (csi) {
        this.pending = s.slice(csi[0].length);
        this.emit({ name: arrows[csi[1]] || "unknown" }); continue;
      }
      if (s[0] === "\x1b") {
        if (s.length === 1) {
          this.escape = setTimeout(() => { this.pending = ""; this.emit({ name: "escape" }); }, 35);
          return;
        }
        // Once a CSI prefix is recognized, SSH latency must not turn it into text.
        if (s.startsWith("\x1b[")) { if (s.length > 128) this.clear(); return; }
        this.pending = s.slice(1); this.emit({ name: "escape" }); continue;
      }
      const char = String.fromCodePoint(s.codePointAt(0)!);
      this.pending = s.slice(char.length);
      const name = char === "\r" || char === "\n" ? "enter" : char === "\x7f" || char === "\b" ? "backspace" : char === "\x03" ? "cancel" : char === "\x15" ? "clear" : char === "\t" ? "tab" : "text";
      if (name === "text" && /[\x00-\x1f\x7f-\x9f]/.test(char)) continue;
      this.emit({ name, text: name === "text" ? char : undefined });
    }
  }
}
export class Line {
  value: string[]; cursor: number;
  constructor(value = "") { this.value = [...value]; this.cursor = this.value.length; }
  get text() { return this.value.join(""); }
  key(key: Key) {
    if (key.name === "text") { const text = [...key.text!]; this.value.splice(this.cursor, 0, ...text); this.cursor += text.length; }
    if (key.name === "backspace" && this.cursor) this.value.splice(--this.cursor, 1);
    if (key.name === "delete") this.value.splice(this.cursor, 1);
    if (key.name === "left") this.cursor = Math.max(0, this.cursor - 1);
    if (key.name === "right") this.cursor = Math.min(this.value.length, this.cursor + 1);
    if (key.name === "home") this.cursor = 0;
    if (key.name === "end") this.cursor = this.value.length;
    if (key.name === "clear") { this.value = []; this.cursor = 0; }
  }
}
