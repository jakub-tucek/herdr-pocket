import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Core, hcBinary } from "../src/core";
import { Backend } from "../src/backend";

test("real isolated hc: shared docs, CAS conflict, launch, worktree, native attach lifecycle", { timeout: 45000 }, async () => {
  const scratch = await mkdtemp(`${process.env.HOME}/.cache/hpt-`), hc = hcBinary();
  const env = { ...process.env, HOME: join(scratch, "home"), HC_BIN: hc, HC_SESSION: "p", XDG_STATE_HOME: join(scratch, "state"), XDG_CONFIG_HOME: join(scratch, "config"), XDG_RUNTIME_DIR: join(scratch, "run") };
  await mkdir(env.HOME); await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  const control = new Core(hc, env);
  const exec = promisify(execFile);
  const tmux = process.env.POCKET_TMUX || "/opt/homebrew/bin/tmux";
  const socket = join(scratch, "tmux.sock");
  let injectConflict = false, conflicts = 0;
  const backend = new Backend(() => {
    const core = new Core(hc, env), rpc = core.rpc.bind(core);
    core.rpc = async (method, params: any = {}, timeout) => {
      if (method === "doc.set" && injectConflict) {
        injectConflict = false; conflicts++;
        const latest = await control.rpc("doc.get", { name: "herdr-app" });
        await control.rpc("doc.set", { name: "herdr-app", version: latest.version, value: { ...latest.value, concurrent: "preserved" } });
      }
      // Check the actual OpenCode launcher without starting a model/client in tests.
      if (method === "terminal.run" && params.argv?.includes("opencode")) {
        assert.ok(params.argv.includes("-lic"));
        params = { ...params, argv: ["/bin/cat"] };
      }
      return rpc(method, params, timeout);
    };
    return core;
  });
  try {
    await control.ready;
    const seed = { spaces: [], custom: { keep: true } };
    await control.rpc("doc.set", { name: "herdr-app", version: 0, value: seed });
    injectConflict = true;
    const first = await backend.launch({ machine: "", folder: env.HOME, name: "Phone", program: "shell" });
    assert.equal(conflicts, 1);
    const doc = await control.rpc("doc.get", { name: "herdr-app" });
    assert.deepEqual(doc.value.custom, { keep: true });
    assert.equal(doc.value.concurrent, "preserved");
    assert.equal(doc.value.spaces.length, 1);
    assert.equal(doc.value.spaces[0].tabs[0].root.children[0].content.terminal, first.address);
    const info = await control.rpc("terminal.get", { terminal: first.address });
    assert.equal(info.labels["herdr.space"], first.space);
    assert.equal(info.keep, true);
    const second = await backend.launch({ machine: "", space: first.space, folder: env.HOME, name: "Agent", program: "opencode" });
    assert.equal((await backend.world()).spaces[0].tabs.length, 2);
    await assert.rejects(backend.launch({ machine: "", space: "missing", folder: env.HOME, program: "shell" }), /Space closed/);
    const repo = join(scratch, "repo");
    await exec("git", ["init", "--initial-branch=main", repo], { env });
    await exec("git", ["-C", repo, "-c", "user.name=Pocket", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "seed"], { env });
    const checkout = await backend.newWorktree(repo, "phone/test", "HEAD", "");
    assert.ok(checkout.startsWith(env.HOME + "/.herdr/worktrees/"));
    assert.ok((await backend.worktrees(repo, "")).some(c => c.branch === "phone/test" && c.path === checkout));
    await assert.rejects(backend.newWorktree(repo, "--force", "HEAD", ""), /Invalid branch/);
    assert.equal((await control.rpc("terminal.get", { terminal: second.address })).state, "live");
    const terminal = await control.rpc("terminal.run", { argv: ["/bin/sh", "-c", "printf 'TUI-ATTACH-OK\\r\\n'; cat"], no_parent: true, no_notify: true });
    const latest = await control.rpc("doc.get", { name: "herdr-app" });
    await control.rpc("doc.set", { name: "herdr-app", version: latest.version, value: { spaces: [{ id: "phone", name: "Phone", folder: env.HOME, tabs: [{ id: "tab", name: "", root: { id: "tab", type: "row", children: [{ id: "pane", type: "block", content: { terminal: terminal.address } }] } }] }] } });
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const result = await exec("python3", [join(root, "test/tty_driver.py"), process.execPath, join(root, "dist/main.js")], { env, timeout: 30000 });
    assert.equal(JSON.parse(result.stdout).tty_restored, true);
    const mouse = await exec("python3", [join(root, "test/tty_driver.py"), process.execPath, join(root, "dist/main.js"), tmux, socket, join(root, "tmux.conf")], { env: { ...env, TERM: "xterm-256color" }, timeout: 30000 });
    assert.equal(JSON.parse(mouse.stdout).tty_restored, true);
    assert.equal(JSON.parse(mouse.stdout).picker_button, true);
    assert.equal((await control.rpc("terminal.get", { terminal: terminal.address })).state, "live", "Leaving the TUI must not kill the program");
  } finally {
    await exec(tmux, ["-S", socket, "kill-server"], { env }).catch(() => {});
    backend.close();
    try { await control.rpc("server.stop"); } catch {}
    control.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
