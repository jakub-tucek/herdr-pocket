import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { Core, hcBinary } from "../src/core";

test("mobile UI: repo + Shell takes two clicks; another client's layout edit syncs live", { timeout: 45000 }, async () => {
  const scratch = await mkdtemp(`${process.env.HOME}/.cache/hpui-`);
  const env = { ...process.env, HOME: join(scratch, "home"), HC_BIN: hcBinary(), HC_SESSION: "u", XDG_STATE_HOME: join(scratch, "state"), XDG_CONFIG_HOME: join(scratch, "config"), XDG_RUNTIME_DIR: join(scratch, "run"), TERM: "xterm-256color" };
  await mkdir(env.HOME); await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  const core = new Core(env.HC_BIN, env), exec = promisify(execFile);
  try {
    const repo = join(env.HOME, "Projects/phone-repo");
    await mkdir(repo, { recursive: true });
    await exec("git", ["init", "-b", "main", repo], { env });
    await exec("git", ["-C", repo, "-c", "user.name=Pocket", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "seed"], { env });
    const terminal = await core.rpc("terminal.run", { argv: ["/bin/cat"], cwd: repo, keep: true, no_parent: true });
    await core.rpc("doc.set", { name: "herdr-app", version: 0, value: { spaces: [{ id: "phone", name: "Phone", folder: repo, tabs: [{ id: "existing", name: "Existing", root: { id: "root", type: "row", children: [{ id: "pane", type: "block", content: { terminal: terminal.address } }] } }] }] } });
    const result = await exec("python3", ["test/ui_driver.py", process.execPath, "dist/main.js"], { env, timeout: 30000 });
    assert.deepEqual(JSON.parse(result.stdout), { two_click_shell: true, live_sync: true });
    const list = await core.rpc("terminal.list");
    assert.equal(list.terminals.filter((t: { state: string }) => t.state === "live").length, 2);
  } finally {
    await core.rpc("server.stop").catch(() => {}); core.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
