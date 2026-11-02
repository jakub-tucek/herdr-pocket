import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Tui refresh failure blocks launches; reconnect immediately rediscovers repositories and restores actions", { timeout: 20000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pocket-reconnect-"));
  try {
    const result = await promisify(execFile)("python3", ["test/reconnect_driver.py", process.execPath, "test/reconnect-harness.ts"], {
      env: { ...process.env, XDG_STATE_HOME: scratch, TERM: "xterm-256color" }, timeout: 17000,
    });
    const report = JSON.parse(result.stdout);
    assert.equal(report.worldCalls, 3, "reconnect uses the next periodic refresh");
    assert.equal(report.discoveries.length, 2, "one initial discovery and one reconnect discovery");
    assert.equal(report.discoveries[0].worldCalls, 1);
    assert.equal(report.discoveries[1].worldCalls, 3);
    assert.ok(report.discoveries[1].at - report.discoveries[0].at < 10000, "rediscovery must not wait for the 60-second discovery interval");
    assert.deepEqual(report.launches, [{
      input: { machine: "test-host", folder: "/projects/repo", name: "repo", program: "shell", reuseFolder: true },
      worldCalls: 3, discoveries: 2,
    }], "neither offline attempt reaches Backend.launch; recovered action does");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
