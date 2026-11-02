import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { launchSession, listWorktrees, parseLaunch, parseWorktrees, type Runtime } from "../sessions";

const exec = promisify(execFile);
test("session creation targets explicit spaces and only allows supported programs", async () => {
  const calls: any[] = [];
  const runtime: Runtime = {
    world: async () => ({ spaces: [{ id: "remote/s1", machine: "remote", name: "Repo", active: false, tabs: [] }] }),
    machines: async () => [{ name: "remote", state: "connected" }],
    exec: async () => ({ code: 0, stdout: "/home/test\n", stderr: "" }),
    command: async (name, args) => { calls.push({ name, args }); return { terminal: "remote/t2" }; },
  };
  await launchSession(runtime, parseLaunch({ kind: "session", program: "opencode", space: "remote/s1", machine: "wrong", name: "Fix" }));
  assert.deepEqual(calls[0], { name: "tab.new", args: { space: "remote/s1", folder: undefined, name: "Fix", argv: ["opencode"] } });
  assert.throws(() => parseLaunch({ kind: "session", program: "sh -c bad" }));
  assert.throws(() => parseLaunch({ kind: "session", program: "shell", argv: ["arbitrary"] }));
  assert.throws(() => parseLaunch({ kind: "worktree-new", program: "shell", repo: "/repo", branch: "--force" }));
  await assert.rejects(launchSession(runtime, parseLaunch({ kind: "session", program: "shell", machine: "missing" })), /unavailable/);
  assert.equal(calls.length, 1);
});

test("real Git worktrees: create, list and open; never force or clean up on launch failure", async () => {
  const scratch = await mkdtemp(`${process.env.HOME}/.cache/hpw-`);
  const repo = join(scratch, "repo with space"), home = join(scratch, "home");
  await mkdir(repo); await mkdir(home);
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => exec("git", ["-C", repo, ...args], { env });
  const calls: any[] = [];
  const runtime: Runtime = {
    machines: async () => [{ name: "remote", state: "connected" }],
    world: async () => ({ spaces: [] }),
    command: async (name, args) => { calls.push({ name, args }); return { terminal: "remote/t2" }; },
    exec: async (argv, machine) => {
      assert.equal(machine, "remote");
      if (argv[0] === "printenv") return { code: 0, stdout: home, stderr: "" };
      try { const r = await exec(argv[0], argv.slice(1), { env }); return { code: 0, stdout: r.stdout, stderr: r.stderr }; }
      catch (e: any) { return { code: e.code, stdout: e.stdout || "", stderr: e.stderr || "" }; }
    },
  };
  try {
    await git("init", "--initial-branch=main");
    await git("-c", "user.name=Pocket Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "seed");
    const request = parseLaunch({ kind: "worktree-new", program: "shell", machine: "remote", repo, branch: "feature/phone" });
    const created = await launchSession(runtime, request);
    assert.equal(created.worktree, join(home, ".herdr/worktrees/repo with space/feature-phone"));
    assert.equal(calls[0].args.folder, created.worktree);
    assert.equal(calls[0].name, "space.new");
    assert.equal(calls[0].args.machine, "remote");
    const checkouts = await listWorktrees(runtime, "remote", repo);
    assert.ok(checkouts.some(c => c.path === created.worktree && c.branch === "feature/phone"));
    runtime.world = async () => ({ spaces: [{ id: "remote/worktree", name: "Phone", machine: "remote", folder: created.worktree + "/functions", active: false, tabs: [] }] });
    const opened = await launchSession(runtime, parseLaunch({ kind: "worktree-open", program: "opencode", machine: "remote", repo, path: created.worktree }));
    assert.equal(opened.worktree, created.worktree);
    assert.equal(calls[1].name, "tab.new");
    assert.equal(calls[1].args.space, "remote/worktree");
    await assert.rejects(launchSession(runtime, request), /already exists|already checked out/);
    await assert.rejects(launchSession(runtime, parseLaunch({ kind: "worktree-open", program: "shell", machine: "remote", repo, path: "/not-a-worktree" })), /not found/);
    runtime.command = async () => { throw new Error("App unavailable"); };
    await assert.rejects(launchSession(runtime, parseLaunch({ ...request, branch: "kept-after-error" })), /Worktree kept at .*App unavailable/);
    const kept = await listWorktrees(runtime, "remote", repo);
    assert.ok(kept.some(c => c.branch === "kept-after-error"));
    // The original checkout was never switched or modified.
    assert.equal((await git("branch", "--show-current")).stdout.trim(), "main");
    assert.equal((await git("status", "--porcelain")).stdout, "");
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("worktree porcelain keeps Unicode/spaces and ignores bare/prunable records", () => {
  assert.deepEqual(parseWorktrees("worktree /repo/český folder\0HEAD abc\0branch refs/heads/topic/a\0\0worktree /bare\0bare\0\0worktree /old\0prunable missing\0\0"), [{ path: "/repo/český folder", branch: "topic/a" }]);
});
