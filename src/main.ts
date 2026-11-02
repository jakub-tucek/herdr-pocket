import { parseArgs } from "node:util";
import { Backend } from "./backend";
import { attachTerminal } from "./terminal";
import { Tui } from "./tui";
import { spaceTerminals } from "./model";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  help: { type: "boolean", short: "h" }, json: { type: "boolean" }, list: { type: "boolean" },
  attach: { type: "string" }, machine: { type: "string" }, space: { type: "string" },
  folder: { type: "string" }, name: { type: "string" }, program: { type: "string" },
  repo: { type: "string" }, branch: { type: "string" }, base: { type: "string" },
  repos: { type: "boolean" },
} });
const backend = new Backend();
try {
  if (values.help) {
    console.log(`herdr-pocket — mobile Herdr terminal\n\n  herdr-pocket                     repos, workspaces and sessions\n  herdr-pocket --list [--json]       inspect shared sessions\n  herdr-pocket --repos [--json]      detected repositories/worktrees\n  herdr-pocket --attach t7           open an existing terminal\n  herdr-pocket new [options]         new Shell/OpenCode terminal\n  herdr-pocket tree [options]        new branch/worktree + terminal\n\nOptions: --machine remote --space <id> --folder ~/repo --name <name>\n         --program shell|opencode --repo <path> --branch <name> --base HEAD\n\nTerminal: pinned Picker/Esc/Tab/history controls; Ctrl+] returns to picker.\nTouch buttons require your SSH client to forward terminal mouse events.`);
  } else if (positionals.length && !["new", "tree"].includes(positionals[0])) {
    throw new Error(`Unknown command: ${positionals[0]}`);
  } else if (positionals[0] === "new" || positionals[0] === "tree") {
    const program = values.program || "opencode";
    if (program !== "shell" && program !== "opencode") throw new Error("Program must be shell or opencode");
    let folder = values.folder;
    if (positionals[0] === "tree") {
      if (!values.repo || !values.branch) throw new Error("tree needs --repo and --branch");
      folder = await backend.newWorktree(values.repo, values.branch, values.base || "HEAD", values.machine || "");
    }
    console.log(JSON.stringify(await backend.launch({ machine: values.machine || "", space: values.space, folder, name: values.name, program })));
  } else if (values.attach) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Attach needs an interactive terminal");
    const world = await backend.world();
    if (!world.spaces.flatMap(spaceTerminals).some(t => t.address === values.attach && t.state === "live")) throw new Error("Live terminal is not in a Herdr space");
    await backend.seen(values.attach).catch(() => {}); backend.close();
    await attachTerminal({ address: values.attach, title: values.attach });
  } else if (values.repos) {
    const repositories = await backend.repositories();
    if (values.json) console.log(JSON.stringify(repositories, null, 2));
    else for (const repo of repositories) console.log(`${repo.machine || "Mac"} / ${repo.name}  ${repo.folder}  (${repo.checkouts.length} worktrees)`);
  } else if (values.list || values.json || !process.stdin.isTTY || !process.stdout.isTTY) {
    const world = await backend.world();
    if (values.json) console.log(JSON.stringify(world, null, 2));
    else for (const space of world.spaces) {
      console.log(`${space.machine || "Mac"} / ${space.name}`);
      for (const tab of space.tabs) for (const pane of tab.panes) console.log(`  ${tab.name}  ${pane.address || "[desktop panel]"}  ${pane.terminal?.status?.title || pane.terminal?.title || ""}`);
    }
  } else await new Tui(backend).run();
} catch (e: any) { console.error(e.message); process.exitCode = 1; }
finally { backend.close(); }
