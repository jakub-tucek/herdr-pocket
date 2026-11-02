import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Backend } from "../src/backend";
import { Core, hcBinary } from "../src/core";
import { flatten, type World } from "../src/model";

test("unreachable remote discovery stops after one bounded parallel wave", async () => {
  const backend = new Backend(() => { throw new Error("No core needed"); });
  let calls = 0;
  backend.exec = async (argv, machine, allowFailure, timeout) => {
    calls++;
    assert.equal(machine, "remote");
    assert.ok(argv[0] === "git" || argv[0] === "printenv");
    assert.equal(timeout, 5);
    throw new Error("SSH unavailable");
  };
  const repositories = await backend.repositories({
    machines: [{ name: "remote", state: "connected" }], spaces: [],
    terminals: Array.from({ length: 500 }, (_, i) => ({ address: `remote/t${i}`, cwd: `/repos/repo${i}`, state: "live", labels: {}, turn: 0 })),
  });
  assert.deepEqual(repositories, []);
  assert.equal(calls, 7, "one discovery request plus six probes, never hundreds of failed RPCs");
});

test("isolated core: repository discovery, machine identity, exact workspace reuse and fast worktrees", { timeout: 60000 }, async () => {
  // macOS Unix sockets allow only 103 bytes, including hc's suffix.
  const scratch = await mkdtemp(join(tmpdir(), "hp-"));
  const env = { ...process.env, HOME: join(scratch, "home"), HC_SESSION: "p", XDG_STATE_HOME: join(scratch, "state"), XDG_CONFIG_HOME: join(scratch, "config"), XDG_RUNTIME_DIR: join(scratch, "run") };
  await mkdir(env.HOME); await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  const core = new Core(hcBinary(), env), backend = new Backend(() => core);
  const exec = promisify(execFile);
  const canonical = await realpath(scratch);
  const repo = join(canonical, "home", "Projects", "owner", "repo with spaces");
  const linked = join(canonical, "linked"), nested = join(repo, "src");
  const git = (args: string[]) => exec("git", args, { env });
  try {
    await core.ready;
    await mkdir(repo, { recursive: true });
    await git(["init", "--initial-branch=main", repo]);
    await git(["-C", repo, "-c", "user.name=Pocket", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "seed"]);
    await git(["-C", repo, "worktree", "add", "-b", "linked", linked]);
    await mkdir(nested);
    const empty: World = { machines: [{ name: "", state: "connected" }], spaces: [], terminals: [] };
    const discovered = await backend.repositories(empty);
    assert.equal(discovered.length, 1, "find repositories without sessions under ~/Projects");
    assert.equal(discovered[0].folder, repo);
    assert.deepEqual(discovered[0].checkouts.map(c => c.path).sort(), [repo, linked].sort());

    const seed = { custom: { keep: "root" }, spaces: [
      { id: "main", name: "Desktop", folder: repo, custom: "workspace", tabs: [] },
      { id: "linked", name: "Linked", folder: linked, tabs: [] },
    ] };
    await core.rpc("doc.set", { name: "herdr-app", version: 0, value: seed });
    const world: World = { ...empty, spaces: flatten(seed, "", []), terminals: [{ address: "t1", cwd: nested, state: "live", labels: {}, turn: 0 }] };
    const extra = join(canonical, "home", "Projects", "others", "sessionless");
    await mkdir(extra, { recursive: true }); await git(["init", extra]);
    const fresh = new Backend(() => core);
    const alongside = await fresh.repositories(world);
    assert.equal(alongside.length, 2, "discover Projects repositories even when other workspaces exist");
    assert.ok(alongside.some(r => r.folder === extra));
    const [repository] = await backend.repositories(world);
    assert.equal(repository.id, discovered[0].id, "subdirectories and linked worktrees share common-dir identity");
    assert.deepEqual(repository.spaceIds.sort(), ["linked", "main"]);
    const first = await backend.launchInRepository(repository, "shell");
    assert.equal(first.space, "main");
    const second = await backend.launchInRepository(repository, "shell", repository.checkouts.find(c => c.path === linked));
    assert.equal(second.space, "linked", "must match the chosen checkout, not just repository identity");
    const after = await core.rpc("doc.get", { name: "herdr-app" });
    assert.deepEqual(after.value.custom, seed.custom);
    assert.equal(after.value.spaces[0].custom, "workspace");
    assert.equal(after.value.spaces.length, 2);
    assert.equal(after.value.spaces[0].tabs.length, 1);
    await assert.rejects(backend.launchInRepository(repository, "shell", "/unrelated"), /does not belong/);

    // Another client publishes the exact checkout after terminal.run but before our CAS.
    const rpc = core.rpc.bind(core);
    let raced = false;
    core.rpc = async (method, params: any = {}, timeout) => {
      if (method === "doc.set" && !raced) {
        raced = true;
        const current = await rpc("doc.get", { name: "herdr-app" });
        const folder = params.value.spaces.at(-1).folder;
        current.value.spaces.push({ id: "raced", name: "Desktop won", folder, tabs: [], custom: "concurrent" });
        await rpc("doc.set", { name: "herdr-app", version: current.version, value: current.value });
      }
      return rpc(method, params, timeout);
    };
    const created = await backend.newRepositoryWorktree(repository, "shell");
    core.rpc = rpc;
    assert.equal(raced, true);
    assert.equal(created.space, "raced", "CAS retry must reuse the concurrently published workspace");
    assert.notEqual(created.space, "main");
    const trees = await backend.worktrees(repo, "");
    assert.ok(trees.some(c => c.path === created.folder && c.branch?.startsWith("pocket/")));
    const newDoc = await core.rpc("doc.get", { name: "herdr-app" });
    assert.equal(newDoc.value.spaces.length, 3);
    assert.equal(newDoc.value.spaces[2].folder, created.folder);
    assert.equal(newDoc.value.spaces[2].custom, "concurrent");
    assert.equal((await core.rpc("terminal.get", { terminal: created.address })).labels["herdr.space"], "raced");

    const originalExec = backend.exec.bind(backend);
    backend.exec = (argv, machine, allowFailure, timeout) => originalExec(argv, machine === "ssh" ? "" : machine, allowFailure, timeout);
    const remote: World = { ...world, machines: [...world.machines, { name: "ssh", state: "connected" }], spaces: [...world.spaces, ...flatten(seed, "ssh", [])] };
    const both = await backend.repositories(remote);
    assert.equal(both.length, 3);
    assert.notEqual(both[0].id, both[1].id, "same path on another machine is a distinct repository");
    assert.deepEqual(both[1].spaceIds.sort(), ["ssh/linked", "ssh/main"]);
    remote.machines[1].state = "offline";
    const offline = await backend.repositories(remote);
    assert.equal(offline.length, 3, "offline machine cannot erase local or cached remote repositories");
    assert.equal(offline.find(r => r.machine === "ssh")?.online, false);
    await assert.rejects(backend.launchInRepository(offline.find(r => r.machine === "ssh")!, "shell"), /offline/);
    remote.machines[1].state = "connected";
    backend.exec = (argv, machine, allowFailure, timeout) => machine === "ssh" ? Promise.reject(new Error("SSH unavailable")) : originalExec(argv, machine, allowFailure, timeout);
    assert.equal((await backend.repositories(remote)).length, 3, "transient errors retain other results");

    // Scan ignores symlinks and dependency trees rather than wandering outside Projects.
    const hiddenRepo = join(scratch, "outside");
    await git(["init", hiddenRepo]);
    await symlink(hiddenRepo, join(env.HOME, "Projects", "symlink"));
    const ignored = join(env.HOME, "Projects", "node_modules", "ignored");
    await mkdir(ignored, { recursive: true }); await git(["init", ignored]);
    const scanned = await new Backend(() => core).repositories(empty);
    assert.equal(scanned.length, 2);
    assert.ok(scanned.every(r => r.folder === repo || r.folder === extra));
  } finally {
    try { await core.rpc("server.stop"); } catch {}
    backend.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
