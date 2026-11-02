import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

// herdr-core generation 1: wire.rs, [channel u32 LE][kind u8][length u32 LE].
export const Kind = { DATA: 0, CREDIT: 1, CLOSE: 2, RESIZE: 3, FOCUS: 4, AUTOMATIC_INPUT: 6 } as const;
const MAX_PAYLOAD = 16 << 20;

export function frame(channel: number, kind: number, payload: Uint8Array): Buffer {
  const out = Buffer.alloc(9 + payload.length);
  out.writeUInt32LE(channel, 0);
  out[4] = kind;
  out.writeUInt32LE(payload.length, 5);
  out.set(payload, 9);
  return out;
}

export class FrameDecoder {
  private buffer = Buffer.alloc(0);
  push(bytes: Uint8Array, emit: (channel: number, kind: number, payload: Buffer) => void) {
    this.buffer = Buffer.concat([this.buffer, bytes]);
    while (this.buffer.length >= 9) {
      const length = this.buffer.readUInt32LE(5);
      if (length > MAX_PAYLOAD) throw new Error("Oversized core frame");
      if (this.buffer.length < 9 + length) return;
      const channel = this.buffer.readUInt32LE(0), kind = this.buffer[4];
      const payload = this.buffer.subarray(9, 9 + length);
      this.buffer = this.buffer.subarray(9 + length);
      emit(channel, kind, payload);
    }
  }
}

export class Core extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private next = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private decoder = new FrameDecoder();
  private line = Buffer.alloc(0);
  private framed = false;
  private closed = false;
  readonly ready: Promise<any>;

  constructor(command = process.env.HC_BIN || `${process.env.HOME}/.local/bin/hc`, env = process.env) {
    super();
    this.child = spawn(command, ["connect"], { env, stdio: "pipe" });
    this.child.stderr.on("data", () => {}); // Do not copy terminal/core data into service logs.
    this.child.stdin.on("error", (e) => this.fail(e));
    this.child.on("error", (e) => this.fail(e));
    this.child.on("exit", () => this.fail(new Error("Core connection closed")));
    this.child.stdout.on("data", (bytes: Buffer) => {
      try {
        if (this.framed) return this.decode(bytes);
        this.line = Buffer.concat([this.line, bytes]);
        if (this.line.length > 1 << 20) throw new Error("Oversized core handshake");
        const end = this.line.indexOf(10);
        if (end < 0) return;
        const reply = JSON.parse(this.line.subarray(0, end).toString());
        const rest = this.line.subarray(end + 1);
        this.line = Buffer.alloc(0);
        if (reply.error || !reply.result?.framed) throw new Error(reply.error?.message || "Core refused framed mode");
        this.framed = true;
        this.reply(reply);
        this.decode(rest);
      } catch (e) { this.fail(e instanceof Error ? e : new Error(String(e))); }
    });
    this.ready = this.request("hello", { generation: 1, framed: true }, true);
  }

  private decode(bytes: Buffer) {
    this.decoder.push(bytes, (channel, kind, payload) => {
      if (channel === 0) this.reply(JSON.parse(payload.toString()));
      else this.emit("frame", channel, kind, payload);
    });
  }
  private reply(message: any) {
    const call = this.pending.get(message.id);
    if (!call) return;
    clearTimeout(call.timer);
    this.pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve(message.result);
  }
  private request(method: string, params: object, hello = false, timeoutMs = 12_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Core connection closed"));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Core timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const data = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      this.child.stdin.write(hello ? Buffer.concat([data, Buffer.from("\n")]) : frame(0, Kind.DATA, data));
    });
  }
  async rpc(method: string, params: object = {}, timeoutMs = 12_000) {
    await this.ready;
    return this.request(method, params, false, timeoutMs);
  }
  send(channel: number, kind: number, payload: Uint8Array) {
    if (this.closed) throw new Error("Core connection closed");
    if (this.child.stdin.writableLength > 1 << 20) throw new Error("Core input queue full");
    this.child.stdin.write(frame(channel, kind, payload));
  }
  credit(channel: number, bytes: number) {
    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(bytes);
    this.send(channel, Kind.CREDIT, payload);
  }
  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); }
    this.pending.clear();
    this.child.kill();
    this.emit("disconnect", error);
  }
  close() { this.fail(new Error("Detached")); }
}
