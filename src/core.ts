import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

export class RpcError extends Error {
  constructor(message: string, readonly kind?: string) { super(message); }
}
export function hcBinary() {
  const local = `${homedir()}/.local/bin/hc`;
  return process.env.HC_BIN || (existsSync(local) ? local : "hc");
}

/** Control plane only. Interactive terminal bytes go straight through hc attach. */
export class Core {
  private child: ChildProcessWithoutNullStreams;
  private next = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  closed = false;
  readonly ready: Promise<any>;
  constructor(readonly bin = hcBinary(), readonly env = process.env) {
    this.child = spawn(bin, ["connect"], { env, stdio: "pipe" });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", line => {
      try {
        const message = JSON.parse(line), call = this.pending.get(message.id);
        if (!call) return;
        this.pending.delete(message.id); clearTimeout(call.timer);
        if (message.error) call.reject(new RpcError(message.error.message, message.error.data?.kind));
        else call.resolve(message.result);
      } catch { this.close(new Error("Invalid hc response")); }
    });
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", e => this.close(e));
    this.child.on("error", e => this.close(e));
    this.child.on("exit", () => this.close(new Error("hc connection closed")));
    this.ready = this.request("hello", { generation: 1 });
  }
  private request(method: string, params: object, timeout = 12_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("hc connection closed"));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async rpc(method: string, params: object = {}, timeout = 12_000): Promise<any> {
    await this.ready;
    return this.request(method, params, timeout);
  }
  close(error = new Error("Disconnected")) {
    if (this.closed) return;
    this.closed = true;
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); }
    this.pending.clear(); this.child.kill();
  }
}
