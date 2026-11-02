import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Core, RpcError } from "./core";
import { flatten, layoutDoc, localId, qualify, type Checkout, type Repository, type LayoutDoc, type Machine, type Terminal, type World } from "./model";

export type Launch = { machine: string; space?: string; folder?: string; name?: string; program: "shell" | "opencode"; reuseFolder?: boolean };
export type { Checkout, Repository } from "./model";
const id = (prefix: string) => prefix + randomUUID().replaceAll("-", "");

export class Backend {
  private core?: Core;
  private stopped = false;
  private cache = new Map<string, LayoutDoc>();
  private repositoryCache = new Map<string, Repository>();
  private discoveryCache = new Map<string, { at: number; paths: string[]; failed: boolean }>();
  constructor(private makeCore = () => new Core()) {}
  api() {
    if (this.stopped) throw new Error("Pocket client closed");
    if (!this.core || this.core.closed) this.core = this.makeCore();
    return this.core;
  }
  close() { this.stopped = true; this.core?.close(); }
  invalidateRepositoryDiscovery() { this.discoveryCache.clear(); }
  async world(): Promise<World> {
    const api = this.api();
    const [list, connected] = await Promise.all([api.rpc("terminal.list"), api.rpc("machine.list")]);
    const machines: Machine[] = [{ name: "", state: "connected" }, ...connected.machines.filter((m: Machine) => !m.temporary).sort((a: Machine, b: Machine) => a.name.localeCompare(b.name))];
    const docs = await Promise.all(machines.map(async machine => {
      if (machine.state === "connected") {
        try {
          const result = await api.rpc("doc.get", { name: "herdr-app", on: machine.name || undefined });
          this.cache.set(machine.name, layoutDoc(result.value));
        } catch (e) {
          machine.state = "unavailable";
        }
      }
      return flatten(this.cache.get(machine.name) || { spaces: [] }, machine.name, list.terminals, machine.state === "connected");
    }));
    return { spaces: docs.flat(), machines, terminals: list.terminals };
  }
  async seen(address: string) {
    const api = this.api(), terminal = await api.rpc("terminal.get", { terminal: address });
    if (terminal.status) await api.rpc("terminal.label", { terminal: address, labels: { "herdr.seen": String(terminal.turn) } });
  }
  async exec(argv: string[], machine: string, allowFailure = false, timeout = 60) {
    const r = await this.api().rpc("machine.exec", { argv, on: machine || undefined, timeout }, (timeout + 10) * 1000);
    const out = Buffer.from(r.stdout, "base64").toString(), err = Buffer.from(r.stderr, "base64").toString();
    if (r.timed_out || r.truncated) throw new Error("Command timed out or output was truncated");
    if (r.code !== 0 && !allowFailure) throw new Error((err || out || "Command failed").trim());
    return { code: r.code as number | null, out: out.trim(), err: err.trim() };
  }
  async folder(path: string | undefined, machine: string, timeout = 60) {
    if (!path || path === "~" || path.startsWith("~/")) {
      const home = (await this.exec(["printenv", "HOME"], machine, false, timeout)).out;
      path = path?.startsWith("~/") ? posix.join(home, path.slice(2)) : home;
    }
    if (!path.startsWith("/") || /[\x00-\x1f]/.test(path)) throw new Error("Use an absolute path or ~/path");
    return posix.normalize(path);
  }
  async launch(input: Launch) {
    const api = this.api(), machine = input.machine;
    let space = input.space ? localId(input.space, machine) : id("sp");
    const tab = id("tb"), pane = id("p");
    const folder = await this.folder(input.folder, machine);
    let argv: string[] | undefined;
    if (input.program === "opencode") {
      const shell = (await this.exec(["printenv", "SHELL"], machine, true)).out || "/bin/sh";
      argv = /\/(ba|z|k)?sh$/.test(shell)
        ? [shell, "-lic", '"$@"; exec "$0" -li', shell, "opencode"]
        : shell.endsWith("/fish") ? [shell, "-lic", "opencode; exec fish -il"] : ["opencode"];
    }
    // Keep it unlabeled until its layout is committed: no auto-adoption race.
    const terminal = await api.rpc("terminal.run", { argv, cwd: folder, on: machine || undefined, keep: true, no_parent: true, no_notify: true });
    const address = terminal.address as string, rawAddress = localId(address, machine);
    let published = false;
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const current = await api.rpc("doc.get", { name: "herdr-app", on: machine || undefined });
        const doc = structuredClone(layoutDoc(current.value));
        const root = { id: tab, type: "row", children: [{ id: pane, type: "block", content: { terminal: rawAddress } }] };
        const entry = { id: tab, name: input.space ? input.name || "" : "", root };
        const matching = input.reuseFolder ? doc.spaces.find(s => s.folder && posix.normalize(s.folder) === folder) : undefined;
        if (input.space) {
          const target = doc.spaces.find(s => s.id === space);
          if (!target) throw new Error("Space closed");
          target.tabs.push(entry);
        } else if (matching) { space = matching.id; matching.tabs.push(entry); }
        else doc.spaces.push({ id: space, name: input.name || "", folder, tabs: [entry] });
        try {
          await api.rpc("doc.set", { name: "herdr-app", on: machine || undefined, version: current.version, value: doc });
          published = true; break;
        } catch (e) { if (!(e instanceof RpcError && e.kind === "conflict") || attempt === 4) throw e; }
      }
      await api.rpc("terminal.label", { terminal: address, labels: { "herdr.space": space, "herdr.tab": tab } });
      return { address, space: qualify(space, machine), tab: qualify(tab, machine), folder };
    } catch (e) {
      // Never kill a published terminal that another client may already use.
      if (!published) await api.rpc("terminal.kill", { terminal: address }).catch(() => {});
      throw e;
    }
  }
  /** Repository identity is machine + git common dir, never a display name. */
  async repositories(world?: World): Promise<Repository[]> {
    world ||= await this.world();
    const results: Repository[] = [];
    await Promise.all(world.machines.map(async machine => {
      const previous = [...this.repositoryCache.values()].filter(r => r.machine === machine.name);
      if (machine.state !== "connected") {
        results.push(...previous.map(r => ({ ...r, online: false })));
        return;
      }
      const candidates = new Set<string>();
      const spaces = world.spaces.filter(s => s.machine === machine.name);
      for (const s of spaces) { if (s.workspaceFolder) candidates.add(s.workspaceFolder); if (s.folder) candidates.add(s.folder); }
      for (const t of world.terminals) {
        // Core addresses are local IDs, or machine/local-ID for SSH terminals.
        const owner = t.address.includes("/") ? t.address.slice(0, t.address.indexOf("/")) : "";
        if (owner === machine.name) { if (t.cwd) candidates.add(t.cwd); if (t.foreground?.cwd) candidates.add(t.foreground.cwd); }
      }
      let failed = false;
      let discovery = this.discoveryCache.get(machine.name);
      if (!discovery || Date.now() - discovery.at > (discovery.failed ? 10_000 : 60_000)) {
        discovery = { at: Date.now(), paths: [], failed: false };
        try {
          const home = await this.folder("~", machine.name, 5);
          // No -L: never follow symlinks. Prune dependency/hidden trees; repo depth <= 3.
          const scan = await this.exec(["find", ...["Projects", "projects", "src"].map(root => posix.join(home, root)), "-maxdepth", "4", "(", "-name", ".git", "-print0", "-prune", ")", "-o", "(", "-type", "d", "(", "-name", "node_modules", "-o", "-name", ".*", ")", "-prune", ")"], machine.name, true, 5);
          discovery.paths = scan.out.split("\0").filter(Boolean).slice(0, 64).map(path => posix.dirname(path));
          // Conventional roots need not exist. Other scan errors retain prior results.
          discovery.failed = scan.code !== 0 && scan.err.split("\n").some(line => line && !line.includes("No such file or directory"));
        } catch { discovery.failed = true; }
        this.discoveryCache.set(machine.name, discovery);
      }
      for (const path of discovery.paths) candidates.add(path);
      failed = discovery.failed;
      const grouped = new Map<string, Repository>();
      const enumerations = new Map<string, Promise<Checkout[]>>();
      const queue = [...candidates].slice(0, 64);
      if (candidates.size > queue.length) failed = true;
      await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
        for (let path: string | undefined; (path = queue.shift()) !== undefined;) {
          try {
            path = await this.folder(path, machine.name, 5);
            const common = await this.exec(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], machine.name, true, 5);
            if (common.code !== 0) continue;
            const commonDir = posix.normalize(common.out), key = JSON.stringify([machine.name, commonDir]);
            if (!enumerations.has(key)) enumerations.set(key, this.worktrees(path, machine.name, 5));
            const checkouts = await enumerations.get(key)!;
            if (!checkouts.length) continue;
            const folder = checkouts.find(c => posix.join(c.path, ".git") === commonDir)?.path || checkouts[0]!.path;
            const repo = grouped.get(key) || { id: key, machine: machine.name, commonDir, folder, name: posix.basename(folder), checkouts: [], spaceIds: [], online: true };
            repo.checkouts = [...new Map([...repo.checkouts, ...checkouts].map(c => [c.path, c])).values()];
            repo.spaceIds = [...new Set([...repo.spaceIds, ...spaces.filter(s =>
              s.workspaceFolder === path || s.folder === path || repo.checkouts.some(c => c.path === (s.workspaceFolder || s.folder))
            ).map(s => s.id)])];
            grouped.set(key, repo);
          } catch { failed = true; queue.length = 0; }
        }
      }));
      // A failed SSH request must not make previously discovered repositories disappear.
      if (failed) for (const old of previous) if (!grouped.has(old.id)) grouped.set(old.id, { ...old, online: false });
      for (const old of previous) this.repositoryCache.delete(old.id);
      for (const repo of grouped.values()) { this.repositoryCache.set(repo.id, repo); results.push(repo); }
    }));
    return results.sort((a, b) => a.machine.localeCompare(b.machine) || a.name.localeCompare(b.name) || a.folder.localeCompare(b.folder));
  }
  async launchInRepository(repo: Repository, program: Launch["program"], checkout?: Checkout | string) {
    if (!repo.online) throw new Error("Repository machine is offline");
    const folder = typeof checkout === "string" ? checkout : checkout?.path || repo.folder;
    if (folder !== repo.folder && !repo.checkouts.some(c => c.path === folder)) throw new Error("Checkout does not belong to repository");
    return this.launch({ machine: repo.machine, folder, name: posix.basename(folder), program, reuseFolder: true });
  }
  async newRepositoryWorktree(repo: Repository, program: Launch["program"]) {
    if (!repo.online) throw new Error("Repository machine is offline");
    const branch = `pocket/${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const folder = await this.newWorktree(repo.folder, branch, "HEAD", repo.machine);
    try { return await this.launch({ machine: repo.machine, folder, name: branch, program, reuseFolder: true }); }
    catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}; checkout kept: ${folder}`); }
  }
  async worktrees(repo: string, machine: string, timeout = 60): Promise<Checkout[]> {
    repo = await this.folder(repo, machine);
    const result = await this.exec(["git", "-C", repo, "worktree", "list", "--porcelain", "-z"], machine, false, timeout);
    return result.out.split("\0\0").flatMap(record => {
      const fields = record.split("\0"), path = fields.find(f => f.startsWith("worktree "))?.slice(9);
      if (!path || fields.includes("bare") || fields.some(f => f.startsWith("prunable"))) return [];
      return [{ path, branch: fields.find(f => f.startsWith("branch refs/heads/"))?.slice(18) || null }];
    });
  }
  async newWorktree(repo: string, branch: string, base: string, machine: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) throw new Error("Invalid branch name");
    repo = await this.folder(repo, machine);
    await this.exec(["git", "check-ref-format", "--branch", branch], machine);
    const common = (await this.exec(["git", "-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], machine)).out;
    const home = await this.folder("~", machine);
    const name = posix.basename(common.endsWith("/.git") ? posix.dirname(common) : common);
    const slug = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    const folder = posix.join(home, ".herdr", "worktrees", name, slug);
    const exists = await this.exec(["git", "-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], machine, true);
    if (exists.code !== 0 && exists.code !== 1) throw new Error(exists.err || "Cannot check branch");
    const commit = exists.code === 0 ? undefined : (await this.exec(["git", "-C", repo, "rev-parse", "--verify", "--end-of-options", `${base || "HEAD"}^{commit}`], machine)).out;
    await this.exec(["git", "-C", repo, "worktree", "add", ...(commit ? ["-b", branch] : []), "--", folder, commit || branch], machine);
    return (await this.exec(["git", "-C", folder, "rev-parse", "--show-toplevel"], machine)).out;
  }
}
