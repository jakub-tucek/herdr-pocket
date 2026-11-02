import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { Core, hcBinary } from "../src/core";
import { TerminalInput, toolbar } from "../src/terminal";
import xterm from "@xterm/headless";
import { setTimeout as delay } from "node:timers/promises";
import { Input } from "../src/input";

test("terminal input preserves UTF-8, keys and paste while intercepting fragmented toolbar clicks", () => {
  const sent: Buffer[] = [], clicks: unknown[] = []; let detached = 0;
  const input = new TerminalInput(b => sent.push(b), () => detached++, (...args) => clicks.push(args));
  const payload = Buffer.from("č🌱\x1b[A\x1b[200~paste\x1d\x1b[<0;4;24M\x1b[201~");
  for (const b of payload) input.feed(Buffer.from([b]));
  assert.deepEqual(Buffer.concat(sent), payload);
  assert.equal(detached, 0); assert.deepEqual(clicks, []);
  for (const b of Buffer.from("\x1b[<0;4;24M")) input.feed(Buffer.from([b]));
  assert.deepEqual(clicks, [[0, 4, 24, false]]);
  input.feed(Buffer.from([0x1d])); assert.equal(detached, 1);
  input.close();
  for (const width of [12, 20, 32, 44, 80]) {
    const buttons = toolbar(width);
    assert.equal(buttons[0].action, "picker");
    assert.ok(buttons.every(b => b.end <= width));
  }
});

test("slow SSH fragments cannot turn bracketed paste into picker commands or detach", async () => {
  const sent: Buffer[] = [], keys: unknown[] = []; let detached = false;
  const input = new TerminalInput(bytes => sent.push(bytes), () => { detached = true; }, () => {});
  const picker = new Input(key => keys.push(key));
  input.feed(Buffer.from("\x1b[20")); picker.feed(Buffer.from("\x1b[20"));
  await delay(180);
  input.feed(Buffer.from("0~q\x1d\x1b[20")); picker.feed(Buffer.from("0~q\x1d\x1b[20"));
  await delay(180);
  input.feed(Buffer.from("1~")); picker.feed(Buffer.from("1~"));
  assert.equal(Buffer.concat(sent).toString(), "\x1b[200~q\x1d\x1b[201~");
  assert.equal(detached, false);
  assert.deepEqual(keys, [{ name: "text", text: "q" }]);
  input.close(); picker.clear();
});

test("custom terminal: real hc, keyboard/mouse/hangup exit, repaint, resize and surviving session", { timeout: 60000 }, async () => {
  const scratch = await mkdtemp(`${process.env.HOME}/.cache/hpterm-`);
  const env = { ...process.env, HOME: join(scratch, "home"), HC_BIN: hcBinary(), HC_SESSION: "t", XDG_STATE_HOME: join(scratch, "state"), XDG_CONFIG_HOME: join(scratch, "config"), XDG_RUNTIME_DIR: join(scratch, "run"), TERM: "xterm-256color" };
  await mkdir(env.HOME); await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  const core = new Core(env.HC_BIN, env), exec = promisify(execFile);
  try {
    const terminal = await core.rpc("terminal.run", { argv: ["/bin/sh", "-c", "printf 'APP-READY\\r\\n'; while IFS= read -r line; do case \"$line\" in clear-screen-*) printf '\\033[2J\\033[HAPP-CLEARED-%s\\r\\n' \"$line\" ;; *) printf '%s\\r\\n' \"$line\" ;; esac; done"], keep: true, no_parent: true, no_notify: true });
    for (const mode of ["mouse", "keyboard", "hangup"]) {
      const result = await exec("python3", ["test/terminal_driver.py", process.execPath, "test/terminal-harness.ts", terminal.address, mode], { env, timeout: 18000 });
      const report = JSON.parse(result.stdout);
      assert.equal(report.tty_restored, true);
      const screen = new xterm.Terminal({ cols: 32, rows: 16, allowProposedApi: true });
      await new Promise<void>(resolve => screen.write(Buffer.from(report.snapshot, "base64"), resolve));
      assert.match(screen.buffer.active.getLine(15)!.translateToString(), /Picker/);
      assert.match(screen.buffer.active.getLine(14)!.translateToString(), /Phone terminal/);
      screen.dispose();
      assert.equal((await core.rpc("terminal.get", { terminal: terminal.address })).state, "live");
    }
    const failedHc = join(scratch, "failed-hc");
    await writeFile(failedHc, "#!/bin/sh\nprintf 'Connection refused\\n'\nexit 7\n", { mode: 0o755 });
    const failure = await exec("python3", ["test/terminal_failure.py", process.execPath, "test/terminal-harness.ts"], { env: { ...env, HC_BIN: failedHc }, timeout: 15000 });
    assert.equal(JSON.parse(failure.stdout).exit_code, 1);
  } finally {
    await core.rpc("server.stop").catch(() => {}); core.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
