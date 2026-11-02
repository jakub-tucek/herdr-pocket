import stringWidth from "string-width";
import { stripVTControlCharacters } from "node:util";
import { rollup, spaceTerminals, status, type Space, type Status, type World } from "./model";

export type Row = { id: string; label: string; meta?: string; status?: Status; kind: "space" | "terminal" | "heading" | "disabled"; space?: Space; address?: string };
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
    const matches = [space.name, space.machine, ...terminals.map(t => `${t.address} ${t.name || ""} ${t.title || ""} ${t.status?.title || ""}`)].join(" ").toLocaleLowerCase().includes(filter);
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
        for (const child of pane.children) result.push({ id: child.address, label: `↳ ${child.name || child.status?.title || child.title || "agent"}`, meta: child.address.split("/").at(-1), status: status(child), kind: "terminal", address: child.address, space });
      }
    }
  }
  return result;
}
const color: Record<string, string> = { blocked: "\x1b[31m", done: "\x1b[32m", working: "\x1b[33m", idle: "\x1b[90m" };
export function rowLine(row: Row, selected: boolean, width: number) {
  if (row.kind === "heading") return `\x1b[90m${pad(" " + row.label, width)}\x1b[0m`;
  const meta = clip(row.meta || "", Math.min(16, Math.floor(width / 3)));
  const room = Math.max(0, width - stringWidth(meta) - 6);
  const label = pad(row.label, room);
  const dot = `${color[row.status || "idle"] || ""}${row.status ? "●" : "·"}\x1b[0m`;
  return `${selected ? "\x1b[48;5;237m" : row.kind === "disabled" ? "\x1b[90m" : ""}${selected ? "›" : " "} ${dot}${selected ? "\x1b[48;5;237m" : ""} ${label} ${meta}${" ".repeat(Math.max(0, width - stringWidth(`  · ${label} ${meta}`)))}\x1b[0m`;
}
export const selectable = (row: Row) => row.kind === "space" || row.kind === "terminal";
export function promptLine(label: string, value: string[], cursor: number, width: number) {
  const prefix = clip(label, Math.max(1, Math.floor(width / 3))) + ": ";
  const room = Math.max(1, width - stringWidth(prefix) - 1);
  let before = value.slice(0, cursor).join("");
  while (stringWidth(before) > room) before = [...before].slice(1).join("");
  const rest = value.slice(cursor).join("");
  const current = [...rest][0] || " ";
  return prefix + clean(before) + "\x1b[7m" + clean(current) + "\x1b[27m" + clip(rest.slice(current === " " && !rest ? 0 : current.length), Math.max(0, width - stringWidth(prefix + before + current)));
}
