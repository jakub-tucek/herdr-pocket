import { execFile } from "node:child_process";
import { posix } from "node:path";
import { Core } from "./core";
import { readWorld, type World } from "./model";

export type Machine = { name: string; state: string; temporary?: boolean };
export type Created = { terminal: string; space?: string; tab?: string; worktree?: string };
export type Launch = {
  kind: "session" | "worktree-new" | "worktree-open";
  program: "opencode" | "shell";
  space: string; machine: string; folder: string; name: string;
  repo: string; branch: string; base: string; path: string;
};
export interface Runtime {
  machines(): Promise<Machine[]>;
  world(): Promise<World>;
  exec(argv: string[], machine: string): Promise<{ code: number | null; stdout: string; stderr: string }>;
  command(name: "space.new" | "tab.new" | "pane.focus", args: object): Promise<any>;
}
export function appCommand(name: string, args: object): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(process.env.HERDR_APP_BIN || `${process.env.HOME}/.local/bin/herdr-app`, ["do", name, JSON.stringify(args)],
      { timeout: 60_000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
        let value: any;
        try { value = JSON.parse(stdout); } catch {}
        if (value?.error || error) return reject(new Error(String(value?.error || stderr?.trim() || "Herdr request failed. Check spaces before retrying.").slice(0, 1500)));
        resolve(value);
      });
  });
}
export async function withRuntime<T>(fn: (runtime: Runtime) => Promise<T>): Promise<T> {
  const core = new Core();
  try {
    return await fn({
      machines: async () => (await core.rpc("machine.list")).machines,
      world: readWorld,
      command: appCommand,
      exec: async (argv, machine) => {
        const result = await core.rpc("machine.exec", { argv, on: machine || undefined, timeout: 60 }, 70_000);
        if (result.timed_out || result.truncated) throw new Error("Command timed out or output was truncated.");
        return { code: result.code, stdout: Buffer.from(result.stdout, "base64").toString(), stderr: Buffer.from(result.stderr, "base64").toString() };
      },
    });
  } finally { core.close(); }
}
function field(value: unknown, max = 4096): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > max || /[\x00-\x1f]/.test(value)) throw new Error("Invalid field.");
  return value.trim();
}
export function parseLaunch(value: any): Launch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid session.");
  const allowed = new Set(["requestId", "kind", "program", "space", "machine", "folder", "name", "repo", "branch", "base", "path"]);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error("Unknown session option.");
  if (!["session", "worktree-new", "worktree-open"].includes(value.kind)) throw new Error("Invalid session type.");
  if (!["opencode", "shell"].includes(value.program)) throw new Error("Choose OpenCode or Shell.");
  const input: Launch = {
    kind: value.kind, program: value.program, space: field(value.space, 256), machine: field(value.machine, 256),
    folder: field(value.folder), name: field(value.name, 120), repo: field(value.repo),
    branch: field(value.branch, 200), base: field(value.base, 200) || "HEAD", path: field(value.path),
  };
  if (input.kind !== "session" && !input.repo) throw new Error("Choose a repository.");
  if (input.kind === "worktree-new" && (!input.branch || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input.branch))) throw new Error("Invalid branch name.");
  if (input.kind === "worktree-open" && !input.path) throw new Error("Choose a worktree.");
  return input;
}
export function parseWorktreeLookup(value: any): { machine: string; repo: string } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["machine", "repo"].includes(key))) throw new Error("Invalid repository.");
  const repo = field(value.repo);
  if (!repo) throw new Error("Choose a repository.");
  return { machine: field(value.machine, 256), repo };
}
async function checkMachine(runtime: Runtime, machine: string) {
  if (!machine) return;
  const target = (await runtime.machines()).find(m => m.name === machine && !m.temporary);
  if (!target || target.state !== "connected") throw new Error("Machine unavailable.");
}
async function checked(runtime: Runtime, argv: string[], machine: string): Promise<string> {
  const result = await runtime.exec(argv, machine);
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || "Command failed.").trim().slice(0, 1500));
  return result.stdout.trim();
}
async function absolutePath(runtime: Runtime, path: string, machine: string): Promise<string> {
  if (path === "~" || path.startsWith("~/")) {
    const home = await checked(runtime, ["printenv", "HOME"], machine);
    path = posix.join(home, path.slice(2));
  }
  if (!path.startsWith("/")) throw new Error("Use an absolute folder path or ~/path.");
  return posix.normalize(path);
}
export type Checkout = { path: string; branch: string | null };
export function parseWorktrees(text: string): Checkout[] {
  const result: Checkout[] = [];
  for (const record of text.split("\0\0")) {
    const fields = record.split("\0");
    const path = fields.find(f => f.startsWith("worktree "))?.slice(9);
    if (!path || fields.includes("bare") || fields.some(f => f.startsWith("prunable"))) continue;
    result.push({ path, branch: fields.find(f => f.startsWith("branch refs/heads/"))?.slice(18) || null });
  }
  return result;
}
export async function listWorktrees(runtime: Runtime, machine: string, repo: string) {
  await checkMachine(runtime, machine);
  const folder = await absolutePath(runtime, repo, machine);
  const text = await checked(runtime, ["git", "-C", folder, "worktree", "list", "--porcelain", "-z"], machine);
  return parseWorktrees(text);
}
export async function launchSession(runtime: Runtime, input: Launch): Promise<Created> {
  const world = await runtime.world();
  const space = input.space ? world.spaces.find(s => s.id === input.space) : undefined;
  if (input.space && !space) throw new Error("Space closed.");
  const machine = space?.machine || input.machine;
  // An existing space owns its machine, including the explicit local machine.
  const on = space ? space.machine || "" : machine;
  await checkMachine(runtime, on);
  const argv = input.program === "opencode" ? ["opencode"] : undefined;
  let folder = input.folder ? await absolutePath(runtime, input.folder, on) : undefined;
  let worktree: string | undefined;
  let targetSpace = input.kind === "session" ? space : undefined;
  if (input.kind !== "session") {
    const repo = await absolutePath(runtime, input.repo, on);
    if (input.kind === "worktree-open") {
      const wanted = await absolutePath(runtime, input.path, on);
      const found = (await listWorktrees(runtime, on, repo)).find(c => c.path === wanted);
      if (!found) throw new Error("Worktree not found.");
      worktree = found.path;
      targetSpace = world.spaces.find(s => (s.machine || "") === on && (s.folder === worktree || s.folder?.startsWith(worktree + "/")));
    } else {
      await checked(runtime, ["git", "check-ref-format", "--branch", input.branch], on);
      const common = await checked(runtime, ["git", "-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], on);
      const home = await checked(runtime, ["printenv", "HOME"], on);
      if (!home.startsWith("/")) throw new Error("Cannot find machine home.");
      const repoName = posix.basename(common.endsWith("/.git") ? posix.dirname(common) : common);
      const slug = input.branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
      worktree = posix.join(home, ".herdr", "worktrees", repoName, slug);
      const exists = await runtime.exec(["git", "-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`], on);
      if (exists.code !== 0 && exists.code !== 1) throw new Error(exists.stderr || "Cannot check branch.");
      const commit = exists.code === 0 ? undefined : await checked(runtime, ["git", "-C", repo, "rev-parse", "--verify", "--end-of-options", `${input.base}^{commit}`], on);
      await checked(runtime, ["git", "-C", repo, "worktree", "add", ...(commit ? ["-b", input.branch] : []), "--", worktree, commit || input.branch], on);
    }
    folder = worktree;
  }
  try {
    if (!targetSpace && !folder) folder = await checked(runtime, ["printenv", "HOME"], on);
    const result = targetSpace
      ? await runtime.command("tab.new", { space: targetSpace.id, folder, name: input.name || undefined, argv })
      : await runtime.command("space.new", { machine: on, folder, name: input.name || undefined, argv });
    if (typeof result?.terminal !== "string") throw new Error("Session requested. Check spaces before retrying.");
    return { ...result, worktree };
  } catch (error: any) {
    if (worktree) throw new Error(`Worktree kept at ${worktree}. ${error.message}`);
    throw error;
  }
}
