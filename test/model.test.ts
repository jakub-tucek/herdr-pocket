import { test } from "node:test";
import assert from "node:assert/strict";
import stringWidth from "string-width";
import { stripVTControlCharacters } from "node:util";
import { flatten, layoutDoc, rollup, status, type Terminal } from "../src/model";
import { clip, rowLine, promptLine, rows } from "../src/render";
import { Input, Line, type Key } from "../src/input";

test("shared layout maps local IDs, split panes, mods and subagents correctly", () => {
  const doc = layoutDoc({ spaces: [{ id: "s1", name: "Phone", folder: "/repo", tabs: [{ id: "tab1", name: "", root: { id: "root", type: "row", children: [
    { id: "p1", type: "block", content: { terminal: "t1" } },
    { id: "split", type: "column", children: [{ id: "p2", type: "block", content: { mod: "annotator" } }] },
  ] } }] }] });
  const terminal: Terminal = { address: "remote/t1", state: "live", cwd: "/repo", labels: {}, turn: 4, status: { state: "working", title: "Current chat" } };
  const child = { ...terminal, address: "remote/t2", parent: "remote/t1" };
  const spaces = flatten(doc, "remote", [terminal, child]);
  assert.equal(spaces[0].id, "remote/s1");
  assert.equal(spaces[0].tabs[0].panes[0].address, "remote/t1");
  assert.equal(spaces[0].tabs[0].panes[0].children[0].address, "remote/t2");
  const list = rows({ spaces, terminals: [terminal, child], machines: [] }, "remote/s1", "");
  assert.ok(list.some(r => r.label === "Current chat"));
  assert.ok(list.some(r => r.kind === "disabled" && r.label.includes("desktop")));
  assert.throws(() => layoutDoc({ unrelated: true }), /Unsupported/);
});
test("attention follows shared herdr.seen and blocked priority", () => {
  const terminal: Terminal = { address: "t1", state: "live", cwd: "/", turn: 3, labels: { "herdr.seen": "2" }, status: { state: "idle" } };
  assert.equal(status(terminal), "done");
  assert.equal(status({ ...terminal, labels: { "herdr.seen": "3" } }), "idle");
  assert.equal(rollup([terminal, { ...terminal, status: { state: "error" } }]), "blocked");
});
test("mobile rendering fits narrow terminals and strips control sequences", () => {
  for (const width of [20, 32, 44, 80]) {
    const line = rowLine({ id: "s", label: "🌱 český project with a very long name\x1b[2J", meta: "remote/t1234", kind: "space", status: "working" }, true, width);
    assert.ok(stringWidth(stripVTControlCharacters(line)) <= width);
    assert.ok(!line.includes("\x1b[2J"));
    assert.ok(stringWidth(clip("日本語の長いプロジェクト", width)) <= width);
    const field = promptLine("Folder", [..."/very/long/path/to/a/checkout"], 29, width);
    assert.ok(stringWidth(stripVTControlCharacters(field)) <= width);
    assert.ok(stripVTControlCharacters(field).includes("checkout"));
  }
});
test("input handles fragmented gestures, arrows, UTF-8 and bracketed paste", () => {
  const events: Key[] = [], input = new Input(key => events.push(key));
  const data = Buffer.from("\x1b[A\x1b[<64;10;4M\x1b[<0;10;4mč\x1b[200~/path with spaces\r\n\x1b[201~");
  for (const byte of data) input.feed(Buffer.from([byte]));
  assert.deepEqual(events.map(k => k.name), ["up", "mouse", "mouse", "text", "text"]);
  assert.equal(events[1].mouse?.button, 64);
  assert.equal(events[2].mouse?.release, true);
  assert.equal(events[3].text, "č");
  assert.equal(events[4].text, "/path with spaces");
  const line = new Line("abc"); line.key({ name: "left" }); line.key({ name: "backspace" }); line.key({ name: "text", text: "č" });
  assert.equal(line.text, "ačc");
  input.clear();
});
