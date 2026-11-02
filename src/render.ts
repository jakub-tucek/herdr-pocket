import stringWidth from "string-width";
import { stripVTControlCharacters } from "node:util";
import { rollup, spaceTerminals, status, type Repository, type Space, type Status, type World } from "./model";

export type PickerRepository = Repository;
export type Row = { id: string; label: string; meta?: string; status?: Status; kind: "space" | "terminal" | "heading" | "disabled" | "repository" | "checkout" | "action"; space?: Space; address?: string; repository?: PickerRepository; path?: string; action?: "opencode" | "shell" | "worktree" };
export function clean(text: string) { return stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ""); }
export function clip(text: string, width: number) {
  text = clean(text);
  if (width <= 0) return "";
  if (stringWidth(text) <= width) return text;
  let out = "";
  for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    if (stringWidth(out + part.segment + "…") > width) break;
    out += part.segment;
  }
  return out + "…";
}
export function pad(text: string, width: number) { const value = clip(text, width); return value + " ".repeat(Math.max(0, width - stringWidth(value))); }
export function rows(world: World, scope: string | undefined, query: string): Row[] {
  const result: Row[] = [], filter = query.toLocaleLowerCase();
  let lastMachine: string | undefined;
  for (const space of world.spaces) {
    if (scope && scope !== space.id) continue;
    const terminals = spaceTerminals(space);
    const matches = [space.name, space.folder, space.machine, ...terminals.map(t => `${t.address} ${t.name || ""} ${t.title || ""} ${t.status?.title || ""}`)].join(" ").toLocaleLowerCase().includes(filter);
    if (!matches) continue;
    if (!scope) {
      if (space.machine !== lastMachine) { result.push({ id: `machine:${space.machine}`, label: space.machine || "Mac", kind: "heading" }); lastMachine = space.machine; }
      result.push({ id: space.id, label: space.name, meta: space.online ? String(terminals.length) : "offline", kind: "space", space, status: rollup(terminals) });
      continue;
    }
    for (const tab of space.tabs) {
      if (space.tabs.length > 1) result.push({ id: tab.id, label: tab.name, kind: "heading" });
      for (const pane of tab.panes) {
        const t = pane.terminal;
        if (!pane.address) { result.push({ id: pane.id, label: `${pane.mod || "Panel"} · desktop`, kind: "disabled" }); continue; }
        result.push({ id: pane.id, label: t?.name || t?.status?.title || t?.title || t?.foreground?.name || "shell", meta: pane.address.split("/").at(-1),
          status: status(t), kind: t?.state === "live" && space.online ? "terminal" : "disabled", address: pane.address, space });
         for (const child of pane.children) result.push({ id: child.address, label: `↳ ${child.name || child.status?.title || child.title || "agent"}`, meta: child.address.split("/").at(-1), status: status(child), kind: space.online && child.state === "live" ? "terminal" : "disabled", address: child.address, space });
      }
    }
  }
  return result;
}
const color: Record<string, string> = { blocked: "\x1b[31m", done: "\x1b[32m", working: "\x1b[33m", idle: "\x1b[90m" };
export function rowLine(row: Row, selected: boolean, width: number, shortcut?: number) {
  if (row.kind === "heading") return `\x1b[90m${pad(" " + row.label, width)}\x1b[0m`;
  const meta = clip(row.meta || "", Math.min(16, Math.floor(width / 3)));
  const room = Math.max(0, width - stringWidth(meta) - 6);
  const label = pad(row.label, room);
  const dot = shortcut ? String(shortcut) : `${color[row.status || "idle"] || ""}${row.status ? "●" : "·"}\x1b[0m`;
  return `${selected ? "\x1b[48;5;237m" : row.kind === "disabled" ? "\x1b[90m" : ""}${selected ? "›" : " "} ${dot}${selected ? "\x1b[48;5;237m" : ""} ${label} ${meta}${" ".repeat(Math.max(0, width - stringWidth(`  · ${label} ${meta}`)))}\x1b[0m`;
}
export const selectable = (row: Row) => row.kind !== "heading" && row.kind !== "disabled";
export function pickerRows(world: World, repositories: PickerRepository[], view: "repos" | "spaces", scope: string | undefined, query: string, checkout?: string): Row[] {
  const filter = query.toLocaleLowerCase();
  const matches = (...values: (string | undefined)[]) => values.join(" ").toLocaleLowerCase().includes(filter);
  const actions = (online: boolean): Row[] => (["opencode", "shell", "worktree"] as const).filter(action => action !== "worktree" || view === "repos").map(action => ({
    id: `action:${action}`, kind: online ? "action" : "disabled", action,
    label: action === "opencode" ? "+ OpenCode" : action === "shell" ? "+ Shell" : "+ Worktree",
    meta: online ? action === "worktree" ? "new branch" : undefined : "offline",
  }));
  const sessions = (spaces: Space[]): Row[] => spaces.flatMap(space => {
    const entries = rows(world, space.id, "");
    const allMatch = matches(space.name, space.folder, space.machine);
    const filtered = entries.filter(row => row.kind !== "heading" && (allMatch || matches(row.label, row.meta, row.address)));
    return filtered.length ? [{ id: `space-heading:${space.id}`, kind: "heading" as const, label: space.name }, ...filtered] : [];
  });
  if (view === "spaces") {
    if (!scope) return rows(world, undefined, query);
    const space = world.spaces.find(s => s.id === scope);
    return space ? [...actions(space.online).filter(row => matches(row.label)), ...sessions([space])] : [];
  }
  if (!scope) return repositories.filter(repo => matches(repo.name, repo.machine, repo.folder,
    ...repo.checkouts.flatMap(c => [c.branch || "detached", c.path]),
    ...world.spaces.filter(s => repo.spaceIds.includes(s.id)).flatMap(s => [s.name, s.folder, ...spaceTerminals(s).flatMap(t => [t.address, t.name, t.title, t.status?.title, t.foreground?.name])]),
  )).sort((a, b) => Number(b.spaceIds.length > 0) - Number(a.spaceIds.length > 0)).map(repo => ({
    id: repo.id, kind: "repository", label: repo.name, repository: repo,
    meta: repo.online ? repo.machine || "local" : "offline",
    status: rollup(world.spaces.filter(s => repo.spaceIds.includes(s.id)).flatMap(spaceTerminals)),
  }));
  const repo = repositories.find(r => r.id === scope);
  if (!repo) return [];
  const checkouts: Row[] = repo.checkouts.length > 1 ? [
    { id: "checkouts", kind: "heading", label: "Checkout · tap to use" },
    ...repo.checkouts.filter(c => matches(c.branch || "detached", c.path)).map(c => ({ id: `checkout:${c.path}`, kind: "checkout" as const, label: `${c.path === (checkout || repo.folder) ? "✓ " : ""}${c.branch || "detached"}`, meta: c.path.split("/").at(-1), path: c.path })),
  ] : [];
  return [...actions(repo.online).filter(row => matches(row.label)), ...sessions(world.spaces.filter(s => repo.spaceIds.includes(s.id))), ...checkouts];
}
export function promptLine(label: string, value: string[], cursor: number, width: number) {
  const prefix = clip(label, Math.max(1, Math.floor(width / 3))) + ": ";
  const room = Math.max(1, width - stringWidth(prefix) - 1);
  let before = value.slice(0, cursor).join("");
  while (stringWidth(before) > room) before = [...before].slice(1).join("");
  const rest = value.slice(cursor).join("");
  const current = [...rest][0] || " ";
  return prefix + clean(before) + "\x1b[7m" + clean(current) + "\x1b[27m" + clip(rest.slice(current === " " && !rest ? 0 : current.length), Math.max(0, width - stringWidth(prefix + before + current)));
}
