import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Core, RpcError } from "./core";
import { flatten, layoutDoc, localId, qualify, type LayoutDoc, type Machine, type Terminal, type World } from "./model";

export type Launch = { machine: string; space?: string; folder?: string; name?: string; program: "shell" | "opencode" };
export type Checkout = { path: string; branch: string | null };
const id = (prefix: string) => prefix + randomUUID().replaceAll("-", "");

export class Backend {
  private core?: Core;
  private cache = new Map<string, LayoutDoc>();
  constructor(private makeCore = () => new Core()) {}
  api() { if (!this.core || this.core.closed) this.core = this.makeCore(); return this.core; }
  close() { this.core?.close(); }
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
          if (!machine.name) throw e;
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
  async exec(argv: string[], machine: string, allowFailure = false) {
    const r = await this.api().rpc("machine.exec", { argv, on: machine || undefined, timeout: 60 }, 70_000);
    const out = Buffer.from(r.stdout, "base64").toString(), err = Buffer.from(r.stderr, "base64").toString();
    if (r.timed_out || r.truncated) throw new Error("Command timed out or output was truncated");
    if (r.code !== 0 && !allowFailure) throw new Error((err || out || "Command failed").trim());
    return { code: r.code as number | null, out: out.trim(), err: err.trim() };
  }
  async folder(path: string | undefined, machine: string) {
    if (!path || path === "~" || path.startsWith("~/")) {
      const home = (await this.exec(["printenv", "HOME"], machine)).out;
      path = path?.startsWith("~/") ? posix.join(home, path.slice(2)) : home;
    }
    if (!path.startsWith("/") || /[\x00-\x1f]/.test(path)) throw new Error("Use an absolute path or ~/path");
    return posix.normalize(path);
  }
  async launch(input: Launch) {
    const api = this.api(), machine = input.machine;
    const space = input.space ? localId(input.space, machine) : id("sp");
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
        if (input.space) {
          const target = doc.spaces.find(s => s.id === space);
          if (!target) throw new Error("Space closed");
          target.tabs.push(entry);
        } else doc.spaces.push({ id: space, name: input.name || "", folder, tabs: [entry] });
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
  async worktrees(repo: string, machine: string): Promise<Checkout[]> {
    repo = await this.folder(repo, machine);
    const result = await this.exec(["git", "-C", repo, "worktree", "list", "--porcelain", "-z"], machine);
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
    return folder;
  }
}
