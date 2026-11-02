import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import { flatten, qualify, type LayoutDoc, type Repository, type Terminal, type World } from "../src/model";
import { pickerRows, rowLine, selectable } from "../src/render";

function fixture(machine = "") {
  const address = (id: string) => qualify(id, machine);
  const terminal = (id: string, name: string): Terminal => ({ address: address(id), name, state: "live", cwd: "/repo", labels: {}, turn: 1 });
  const terminals = [terminal("t1", "OpenCode"), terminal("t2", "Shell"), terminal("t3", "Second tab"), {
    ...terminal("child", "Review worker"), parent: address("t1"), status: { state: "working", title: "Inspecting changes" },
  }];
  const doc: LayoutDoc = { spaces: [{ id: "space", name: "Main workspace", folder: "/repo", tabs: [
    { id: "tab1", name: "Split", root: { id: "root", type: "row", children: [
      { id: "p1", type: "block", content: { terminal: "t1" } },
      { id: "p2", type: "block", content: { terminal: "t2" } },
      { id: "mod", type: "block", content: { mod: "annotator" } },
    ] } },
    { id: "tab2", name: "Other", root: { id: "p3", type: "block", content: { terminal: "t3" } } },
  ] }] };
  const world: World = { spaces: flatten(doc, machine, terminals), terminals, machines: [{ name: machine, state: "connected" }] };
  const repo: Repository = { id: JSON.stringify([machine, "/repo/.git"]), name: "Same repo", machine, folder: "/repo", online: true,
    checkouts: [{ path: "/repo", branch: "main" }, { path: "/worktrees/feature", branch: "feature/mobile" }], spaceIds: [address("space")] };
  const list = (query = "", checkout?: string) => pickerRows(world, [repo], "repos", repo.id, query, checkout);
  return { world, repo, list, address };
}

test("repository then action is a two-step path to OpenCode, shell or a new worktree", () => {
  const { world, repo } = fixture();
  const roots = pickerRows(world, [repo], "repos", undefined, "").filter(selectable);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].kind, "repository");
  assert.equal(roots[0].repository, repo);
  const selected = pickerRows(world, [repo], "repos", roots[0].id, "");
  assert.deepEqual(selected.slice(0, 3).map(row => [row.label, row.action, row.kind]), [
    ["+ OpenCode", "opencode", "action"], ["+ Shell", "shell", "action"], ["+ Worktree", "worktree", "action"],
  ]);
  assert.ok(selected.slice(0, 3).every(selectable));
});

test("existing sessions precede even a large checkout list; direct actions stay first", () => {
  const { repo, list } = fixture();
  repo.checkouts.push(...Array.from({ length: 30 }, (_, i) => ({ path: `/worktrees/task-${i}`, branch: `task/${i}` })));
  const result = list();
  const firstCheckout = result.findIndex(row => row.kind === "checkout");
  assert.deepEqual(result.slice(0, 3).map(row => row.action), ["opencode", "shell", "worktree"]);
  assert.equal(result.filter(row => row.kind === "checkout").length, 32);
  assert.ok(result.filter(row => row.address).every(row => result.indexOf(row) < firstCheckout));
  assert.ok(result.slice(0, 8).some(row => row.address));
});

test("all split panes, tabs and subagents remain reachable; desktop panels do not attach", () => {
  const { list, address } = fixture("remote");
  const result = list();
  assert.deepEqual(result.filter(row => row.address && selectable(row)).map(row => row.address), [address("t1"), address("child"), address("t2"), address("t3")]);
  assert.ok(result.some(row => row.label === "↳ Review worker" && row.status === "working"));
  const panel = result.find(row => row.id === address("mod"));
  assert.ok(panel);
  assert.equal(selectable(panel), false);
  assert.equal(panel.address, undefined);
});

test("fresh world snapshots update labels, status and panes without changing surviving row IDs", () => {
  const { world, repo, list } = fixture();
  const before = list();
  const updated = structuredClone(world);
  const pane = updated.spaces[0].tabs[0].panes[0];
  assert.ok(pane.terminal);
  pane.terminal.name = "Needs approval";
  pane.terminal.status = { state: "blocked" };
  updated.spaces[0].tabs[0].panes = updated.spaces[0].tabs[0].panes.filter(p => p.address !== "t2");
  const extra: Terminal = { address: "new", name: "New shell", state: "live", cwd: "/repo", turn: 0, labels: {} };
  updated.spaces[0].tabs[1].panes.push({ id: "new-pane", address: extra.address, terminal: extra, children: [] });
  const after = pickerRows(updated, [repo], "repos", repo.id, "");
  assert.equal(after.find(row => row.address === "t1")?.id, before.find(row => row.address === "t1")?.id);
  assert.equal(after.find(row => row.address === "t1")?.label, "Needs approval");
  assert.equal(after.find(row => row.address === "t1")?.status, "blocked");
  assert.equal(after.some(row => row.address === "t2"), false);
  assert.ok(after.some(row => row.address === "new" && selectable(row)));
  assert.equal(pickerRows(updated, [repo], "repos", undefined, "")[0].status, "blocked");
  assert.equal(before.find(row => row.address === "t1")?.label, "OpenCode");
});

test("offline repositories and spaces retain visible sessions but disable launches and attaches", () => {
  const { world, repo, list } = fixture("remote");
  repo.online = false;
  world.spaces[0].online = false;
  const result = list();
  assert.equal(result.filter(row => row.action).length, 3);
  assert.ok(result.filter(row => row.action).every(row => !selectable(row) && row.meta === "offline"));
  assert.ok(result.filter(row => row.address).every(row => !selectable(row)));
  const roots = pickerRows(world, [repo], "repos", undefined, "");
  assert.equal(roots[0].meta, "offline");
  assert.ok(selectable(roots[0]), "offline details remain inspectable");
  const spaceRows = pickerRows(world, [], "spaces", world.spaces[0].id, "");
  assert.ok(spaceRows.filter(row => row.action || row.address).every(row => !selectable(row)));
});

test("same-name repositories and paths on different machines never mix sessions", () => {
  const local = fixture(), remote = fixture("remote");
  const world: World = { spaces: [...local.world.spaces, ...remote.world.spaces], terminals: [...local.world.terminals, ...remote.world.terminals], machines: [...local.world.machines, ...remote.world.machines] };
  const repos = [local.repo, remote.repo];
  const roots = pickerRows(world, repos, "repos", undefined, "");
  assert.equal(new Set(roots.map(row => row.id)).size, 2);
  assert.deepEqual(roots.map(row => row.meta), ["local", "remote"]);
  for (const { repo, address } of [local, remote]) {
    assert.deepEqual(pickerRows(world, repos, "repos", repo.id, "").filter(row => row.address).map(row => row.address), [address("t1"), address("child"), address("t2"), address("t3")]);
  }
});

test("search finds repositories by machine, checkout branch/path, workspace and session titles", () => {
  const { world, repo } = fixture("remote");
  for (const query of ["SAME REPO", "REMOTE", "/worktrees/feature", "feature/mobile", "Main workspace", "Review worker", "Inspecting changes", "remote/t2"]) {
    assert.deepEqual(pickerRows(world, [repo], "repos", undefined, query).map(row => row.id), [repo.id], query);
  }
  assert.deepEqual(pickerRows(world, [repo], "repos", undefined, "no-such-repo"), []);
  const child = pickerRows(world, [repo], "repos", repo.id, "REVIEW WORKER");
  assert.deepEqual(child.filter(selectable).map(row => row.address), ["remote/child"]);
  assert.equal(pickerRows(world, [repo], "repos", repo.id, "SHELL").find(row => row.action)?.action, "shell");
});

test("checkout selection marks the chosen path, including detached worktrees", () => {
  const { repo, list } = fixture();
  repo.checkouts.push({ path: "/worktrees/detached", branch: null });
  assert.equal(list().find(row => row.label.startsWith("✓"))?.path, "/repo");
  const selected = list("", "/worktrees/detached").filter(row => row.kind === "checkout");
  assert.equal(selected.filter(row => row.label.startsWith("✓")).length, 1);
  assert.equal(selected.find(row => row.path === "/worktrees/detached")?.label, "✓ detached");
  assert.ok(selected.every(selectable));
});

test("spaces view reaches nonrepository workspaces and offers direct launches without worktree action", () => {
  const { world } = fixture();
  world.spaces[0].folder = "/notes";
  world.spaces[0].name = "Personal notes";
  assert.deepEqual(pickerRows(world, [], "repos", undefined, ""), []);
  const roots = pickerRows(world, [], "spaces", undefined, "NOTES").filter(selectable);
  assert.equal(roots.length, 1);
  const result = pickerRows(world, [], "spaces", roots[0].id, "");
  assert.deepEqual(result.filter(row => row.action).map(row => row.action), ["opencode", "shell"]);
  assert.equal(result.filter(row => row.address && selectable(row)).length, 4);
});

test("compact rows fit mobile widths with numbered shortcuts, Unicode and untrusted labels", () => {
  const { repo, list } = fixture();
  repo.checkouts.push({ path: "/worktrees/日本語🌱\x1b[2J", branch: "日本語🌱e\u0301\x1b[2J\r\nbranch" });
  const result = list();
  for (const width of [12, 16, 20, 32, 44]) {
    for (const selected of [true, false]) {
      let shortcut = 0;
      for (const row of result) {
        const number = selectable(row) && shortcut < 9 ? ++shortcut : undefined;
        const line = rowLine(row, selected, width, number);
        const plain = stripVTControlCharacters(line);
        assert.equal(stringWidth(plain), width, `${width}: ${row.label}`);
        assert.ok(!line.includes("\x1b[2J"));
        assert.ok(!/[\r\n]/.test(plain));
        if (number) assert.ok(plain.startsWith(`${selected ? "›" : " "} ${number} `));
      }
    }
  }
});

test("empty and removed scopes produce no stale sessions or actions", () => {
  const world: World = { spaces: [], terminals: [], machines: [] };
  for (const view of ["repos", "spaces"] as const) {
    assert.deepEqual(pickerRows(world, [], view, undefined, ""), []);
    assert.deepEqual(pickerRows(world, [], view, "removed", ""), []);
  }
});
