import { execFile } from "node:child_process";

export type Pane = { terminal: string; pane: string; status: string | null; app: string | null; name: string | null; sub_agents: string[] };
export type Tab = { id: string; name: string; active: boolean; terminals: Pane[] };
export type Space = { id: string; name: string; folder?: string; machine: string | null; active: boolean; tabs: Tab[] };
export type World = { spaces: Space[] };

export function readWorld(): Promise<World> {
  return new Promise((resolve, reject) => {
    execFile(process.env.HERDR_APP_BIN || `${process.env.HOME}/.local/bin/herdr-app`, ["ls"],
      { timeout: 8000, maxBuffer: 4 << 20 }, (error, stdout) => {
        if (error) return reject(new Error("Cannot read Herdr app. Keep the desktop app open."));
        try {
          const world = JSON.parse(stdout);
          if (!Array.isArray(world.spaces)) throw new Error("Invalid Herdr app response");
          resolve(world);
        } catch { reject(new Error("Invalid Herdr app response")); }
      });
  });
}

export function terminalAllowed(world: World, address: string): boolean {
  return world.spaces.some(s => s.tabs.some(t => t.terminals.some(p => p.terminal === address || p.sub_agents.includes(address))));
}
