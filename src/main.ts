import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { Backend } from "./backend";
import { hcBinary } from "./core";
import { Tui } from "./tui";
import { spaceTerminals } from "./model";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  help: { type: "boolean", short: "h" }, json: { type: "boolean" }, list: { type: "boolean" },
  attach: { type: "string" }, machine: { type: "string" }, space: { type: "string" },
  folder: { type: "string" }, name: { type: "string" }, program: { type: "string" },
  repo: { type: "string" }, branch: { type: "string" }, base: { type: "string" },
} });
const backend = new Backend();
try {
  if (values.help) {
    console.log(`herdr-pocket — shared Herdr sessions, in Termius\n\n  herdr-pocket                     spaces and terminals\n  herdr-pocket --list [--json]       inspect shared sessions\n  herdr-pocket --attach t7           attach an existing terminal\n  herdr-pocket new [options]         new Shell/OpenCode terminal\n  herdr-pocket tree [options]        new branch/worktree + terminal\n\nOptions: --machine remote --space <id> --folder ~/repo --name <name>\n         --program shell|opencode --repo <path> --branch <name> --base HEAD\n\nPicker: Enter open · Esc spaces · / find · n new · w worktree · q quit\nTerminal: Ctrl+\\ returns to the picker. No session is copied or restarted.`);
  } else if (positionals[0] === "new" || positionals[0] === "tree") {
    const program = values.program || "opencode";
    if (program !== "shell" && program !== "opencode") throw new Error("Program must be shell or opencode");
    let folder = values.folder;
    if (positionals[0] === "tree") {
      if (!values.repo || !values.branch) throw new Error("tree needs --repo and --branch");
      folder = await backend.newWorktree(values.repo, values.branch, values.base || "HEAD", values.machine || "");
    }
    console.log(JSON.stringify(await backend.launch({ machine: values.machine || "", space: values.space, folder, name: values.name, program })));
  } else if (values.list || values.json || !process.stdin.isTTY || !process.stdout.isTTY) {
    const world = await backend.world();
    if (values.json) console.log(JSON.stringify(world, null, 2));
    else for (const space of world.spaces) {
      console.log(`${space.machine || "Mac"} / ${space.name}`);
      for (const tab of space.tabs) for (const pane of tab.panes) console.log(`  ${tab.name}  ${pane.address || "[desktop panel]"}  ${pane.terminal?.status?.title || pane.terminal?.title || ""}`);
    }
  } else if (values.attach) {
    const world = await backend.world();
    if (!world.spaces.flatMap(spaceTerminals).some(t => t.address === values.attach)) throw new Error("Terminal is not in a Herdr space");
    await backend.seen(values.attach).catch(() => {}); backend.close();
    const child = spawn(hcBinary(), ["attach", values.attach], { stdio: "inherit" });
    await new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("exit", code => { process.exitCode = code || 0; resolve(); }); });
  } else await new Tui(backend).run();
} catch (e: any) { console.error(e.message); process.exitCode = 1; }
finally { backend.close(); }
