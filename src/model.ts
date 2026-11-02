export type Node = { id: string; type: string; content?: { terminal?: string; mod?: string }; children?: Node[]; [key: string]: unknown };
export type TabDoc = { id: string; name: string; root: Node; [key: string]: unknown };
export type SpaceDoc = { id: string; name: string; folder: string; tabs: TabDoc[]; [key: string]: unknown };
export type LayoutDoc = { spaces: SpaceDoc[]; [key: string]: unknown };
export type Status = "working" | "blocked" | "done" | "idle" | undefined;
export type Terminal = {
  address: string; state: string; cwd: string; title?: string; name?: string;
  foreground?: { cwd?: string; name?: string }; labels: Record<string, string>;
  status?: { state?: string; title?: string; app?: string }; turn: number; parent?: string;
};
export type Pane = { id: string; address?: string; mod?: string; terminal?: Terminal; children: Terminal[] };
export type Tab = { id: string; name: string; panes: Pane[] };
export type Space = { id: string; localId: string; name: string; folder: string; workspaceFolder?: string; machine: string; tabs: Tab[]; online: boolean };
export type Checkout = { path: string; branch: string | null };
export type Repository = { id: string; name: string; machine: string; folder: string; commonDir?: string; checkouts: Checkout[]; spaceIds: string[]; online: boolean };
export type Machine = { name: string; state: string; temporary?: boolean };
export type World = { spaces: Space[]; machines: Machine[]; terminals: Terminal[] };

export function qualify(id: string, machine: string) { return machine ? `${machine}/${id}` : id; }
export function localId(id: string, machine: string) {
  if (!machine) return id;
  const prefix = `${machine}/`;
  if (!id.startsWith(prefix)) throw new Error("Wrong machine for this space");
  return id.slice(prefix.length);
}
export function layoutDoc(value: unknown): LayoutDoc {
  if (value === null || value === undefined) return { spaces: [] };
  const doc = value as LayoutDoc;
  if (!doc || !Array.isArray(doc.spaces) || doc.spaces.some(s => !s || typeof s.id !== "string" || !Array.isArray(s.tabs))) throw new Error("Unsupported Herdr layout; not changed");
  return doc;
}
export function nodes(root: Node): Node[] {
  return [root, ...(root.children || []).flatMap(nodes)];
}
export function status(t?: Terminal): Status {
  const state = t?.status?.state;
  if (state === "working") return "working";
  if (state === "blocked" || state === "error") return "blocked";
  if (state) return t!.turn > Number(t!.labels?.["herdr.seen"] ?? -1) ? "done" : "idle";
}
export function rollup(terminals: Terminal[]): Status {
  const all = terminals.map(status);
  return (["blocked", "done", "working", "idle"] as const).find(s => all.includes(s));
}
export function flatten(doc: LayoutDoc, machine: string, terminals: Terminal[], online = true): Space[] {
  const byAddress = new Map(terminals.map(t => [t.address, t]));
  return doc.spaces.map(s => {
    const tabs = s.tabs.map((tab, index) => ({
      id: qualify(tab.id, machine), name: tab.name || String(index + 1),
      panes: nodes(tab.root).filter(n => n.content?.terminal || n.content?.mod).map(n => {
        const address = n.content?.terminal ? qualify(n.content.terminal, machine) : undefined;
        const terminal = address ? byAddress.get(address) : undefined;
        return { id: qualify(n.id, machine), address, terminal, mod: n.content?.mod,
          children: address ? terminals.filter(t => t.parent === address && t.state === "live") : [] };
      }),
    }));
    const first = tabs.flatMap(t => t.panes).find(p => p.terminal)?.terminal;
    const folder = first?.foreground?.cwd || first?.cwd || s.folder;
    const name = s.name || folder.replace(/\/$/, "").split("/").at(-1) || "~";
    return { id: qualify(s.id, machine), localId: s.id, name, folder, workspaceFolder: s.folder, machine, tabs, online };
  });
}
export function spaceTerminals(space: Space): Terminal[] {
  return space.tabs.flatMap(t => t.panes.flatMap(p => [...p.terminal ? [p.terminal] : [], ...p.children]));
}
