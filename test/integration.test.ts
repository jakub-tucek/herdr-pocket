import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { WebSocket } from "ws";
import { Core } from "../core";
import { randomUUID } from "node:crypto";

test("isolated real hc: pairing, watch without resize, control, input, detach", { timeout: 30000 }, async () => {
  // macOS Unix sockets allow only 103 bytes; its normal TMPDIR is too long.
  const scratch = await mkdtemp(`${process.env.HOME}/.cache/hpt-`);
  const env = { ...process.env, HOME: join(scratch, "home"), HC_BIN: `${process.env.HOME}/.local/bin/hc`, HC_SESSION: "p", XDG_STATE_HOME: join(scratch, "state"), XDG_CONFIG_HOME: join(scratch, "config"), XDG_RUNTIME_DIR: join(scratch, "runtime") };
  await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  await mkdir(env.HOME);
  const repo = join(scratch, "repo-ui");
  const git = (...args: string[]) => promisify(execFile)("git", args, { env });
  await git("init", "--initial-branch=main", repo);
  await git("-C", repo, "-c", "user.name=Pocket Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "seed");
  const core = new Core(undefined, env);
  let server: ChildProcessWithoutNullStreams | undefined;
  const sockets: WebSocket[] = [];
  try {
    await core.ready;
    const terminal = await core.rpc("terminal.run", { argv: ["/bin/cat"], no_parent: true, no_notify: true });
    const before = await core.rpc("terminal.get", { terminal: terminal.address });
    const fixture = join(scratch, "herdr-app");
    const worldFile = join(scratch, "world.json"), commandLog = join(scratch, "commands.jsonl");
    await writeFile(worldFile, JSON.stringify({ spaces: [{ id: "s1", name: "Test", folder: repo, machine: null, tabs: [{ id: "tab1", name: "1", terminals: [{ terminal: terminal.address, sub_agents: [] }] }] }] }));
    await writeFile(commandLog, "");
    await writeFile(fixture, `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const file = ${JSON.stringify(worldFile)}, log = ${JSON.stringify(commandLog)};
const world = JSON.parse(fs.readFileSync(file, 'utf8'));
if (process.argv[2] === 'ls') console.log(JSON.stringify(world));
else if (process.argv[2] === 'do') {
  const command = process.argv[3], args = JSON.parse(process.argv[4]);
  fs.appendFileSync(log, JSON.stringify({ command, args }) + '\\n');
  const run = cp.spawnSync(${JSON.stringify(`${process.env.HOME}/.local/bin/hc`)}, ['run', '--bg', '--json', '--no-parent', '--no-notify', '--', '/bin/cat'], { encoding: 'utf8', env: process.env });
  if (run.status !== 0) { console.log(JSON.stringify({error: run.stderr})); process.exit(1); }
  const terminal = JSON.parse(run.stdout).address;
  let space = args.space && world.spaces.find(s => s.id === args.space);
  if (!space) { space = {id:'s-' + terminal, name:args.name || 'New space', machine:null, folder:args.folder, tabs:[]}; world.spaces.push(space); }
  const tab = {id:'tab-' + terminal, name: command === 'tab.new' && args.name || String(space.tabs.length + 1), terminals:[{terminal, sub_agents:[]}]};
  space.tabs.push(tab); fs.writeFileSync(file, JSON.stringify(world));
  console.log(JSON.stringify({terminal, space:space.id, tab:tab.id}));
}
`, { mode: 0o700 });
    const port = 21000 + Math.floor(Math.random() * 10000), origin = `http://127.0.0.1:${port}`, state = join(scratch, "pocket");
    server = spawn(process.execPath, ["--import", "tsx", "server.ts"], { cwd: join(dirname(fileURLToPath(import.meta.url)), ".."), env: { ...env, PORT: String(port), POCKET_STATE: state, HERDR_APP_BIN: fixture }, stdio: "pipe" });
    server.stderr.on("data", bytes => process.stderr.write(bytes));
    const [started] = await once(server.stdout, "data");
    assert.match(started.toString(), /Herdr Pocket:/);
    assert.equal((await fetch(`${origin}/api/world`)).status, 401);
    const key = (await readFile(join(state, "pairing-key"), "utf8")).trim();
    const login = await fetch(`${origin}/api/login`, { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.match(login.headers.get("set-cookie")!, /HttpOnly/);
    assert.equal((await fetch(`${origin}/api/world`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${origin}/api/login`, { method: "POST", body: JSON.stringify({ key }) })).status, 403);

    async function denied(headers: Record<string, string>, address = terminal.address) {
      return new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`${origin.replace("http", "ws")}/terminal?id=${address}&cols=80&rows=24`, { headers });
        sockets.push(ws);
        ws.on("unexpected-response", (_req, response) => { response.resume(); ws.terminate(); resolve(response.statusCode!); });
        ws.on("error", () => {});
        ws.on("open", () => { ws.terminate(); reject(new Error("Unauthorized stream opened")); });
      });
    }
    assert.equal(await denied({ origin }), 401);
    assert.equal(await denied({ origin: "https://attacker.test", cookie }), 403);
    assert.equal(await denied({ cookie }), 403);
    assert.equal(await denied({ origin, cookie }, "not-open-in-herdr"), 404);

    const open = (control: boolean, fit = false) => new Promise<{ ws: WebSocket; messages: any[]; output: () => string }>((resolve, reject) => {
      const ws = new WebSocket(`${origin.replace("http", "ws")}/terminal?id=${terminal.address}&cols=37&rows=11&control=${control ? 1 : 0}&fit=${fit ? 1 : 0}`, { headers: { origin, cookie } });
      sockets.push(ws);
      const messages: any[] = []; let output = "";
      const timeout = setTimeout(() => reject(new Error("Attach timed out")), 12000);
      ws.on("message", (data, binary) => {
        if (!binary) {
          const message = JSON.parse(data.toString()); messages.push(message);
          if (message.type === "ready") { clearTimeout(timeout); resolve({ ws, messages, output: () => output }); }
        } else {
          const bytes = Buffer.from(data as Buffer); output += bytes.toString();
          ws.send(JSON.stringify({ type: "credit", bytes: bytes.length }));
        }
      });
      ws.on("error", error => { clearTimeout(timeout); reject(error); });
    });
    const watch = await open(false);
    assert.equal(watch.messages[0].control, false);
    const watching = await core.rpc("terminal.get", { terminal: terminal.address });
    assert.deepEqual([watching.cols, watching.rows], [before.cols, before.rows]);
    const rejected = once(watch.ws, "close");
    watch.ws.send(JSON.stringify({ type: "input", text: "forbidden\r" }));
    assert.equal((await rejected)[0], 1008);
    const fitted = await open(false, true);
    assert.equal(fitted.messages[0].control, false);
    assert.equal(fitted.messages[0].fit, true);
    const fitSize = await core.rpc("terminal.get", { terminal: terminal.address });
    assert.deepEqual([fitSize.cols, fitSize.rows], [37, 11]);
    const fitRejected = once(fitted.ws, "close");
    fitted.ws.send(JSON.stringify({ type: "input", text: "still-forbidden\r" }));
    assert.equal((await fitRejected)[0], 1008);
    const control = await open(true);
    const controlled = await core.rpc("terminal.get", { terminal: terminal.address });
    assert.deepEqual([controlled.cols, controlled.rows], [37, 11]);
    const echoed = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("No echoed input")), 5000);
      control.ws.on("message", () => { if (control.output().includes("pocket-input-ok")) { clearTimeout(deadline); resolve(); } });
    });
    control.ws.send(JSON.stringify({ type: "input", text: "pocket-input-ok\r" }));
    await echoed;
    control.ws.close();
    assert.equal((await core.rpc("terminal.get", { terminal: terminal.address })).state, "live");
    if (process.env.POCKET_BROWSER_TEST === "1") {
      const { chromium } = await import("playwright-core");
      const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        const typed: string[] = [];
        page.on("websocket", ws => ws.on("framesent", event => {
          if (typeof event.payload !== "string") return;
          const message = JSON.parse(event.payload);
          if (message.type === "input") typed.push(message.text);
        }));
        await page.goto(origin);
        await page.evaluate(() => localStorage.setItem("inputMode", "watch"));
        await page.locator("#key").fill(key);
        await page.locator("#pair-form button").click();
        await page.locator(".space-name").waitFor();
        assert.equal(await page.locator(".session").count(), 0);
        await page.locator(".space-name").click();
        await page.locator(".session").click();
        await page.waitForFunction(() => document.getElementById("app")?.dataset.terminalState === "watch");
        assert.equal(await page.locator("#notice").isVisible(), false);
        const mobile = await core.rpc("terminal.get", { terminal: terminal.address });
        assert.ok(mobile.cols >= 30 && mobile.cols <= 55, `Unexpected phone width: ${mobile.cols}`);
        assert.equal(await page.locator("#compose").isVisible(), false);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
        await page.screenshot({ path: "/tmp/herdr-pocket-fit-test.png" });
        // A normal browser refresh must preserve the current terminal, not just
        // a refresh initiated by the update banner.
        await page.reload();
        await page.waitForFunction(() => document.getElementById("app")?.dataset.terminalState === "watch", {}, { timeout: 1500 });
        assert.equal(await page.locator("#title").textContent(), "Test / 1");
        assert.equal(new URL(page.url()).searchParams.get("terminal"), terminal.address);
        await page.goBack();
        await page.waitForFunction(() => document.getElementById("app")?.dataset.terminalState === "idle");
        assert.equal(await page.locator("#sidebar").isVisible(), true);
        await page.locator("#search").fill("Test");
        await page.reload();
        await page.locator("#sidebar").waitFor({ state: "visible" });
        await page.waitForFunction(() => document.getElementById("app")?.dataset.terminalState === "idle");
        assert.equal(await page.locator("#search").inputValue(), "Test");
        assert.equal(new URL(page.url()).searchParams.get("q"), "Test");
        await page.goForward();
        await page.waitForFunction(() => document.getElementById("app")?.dataset.terminalState === "watch");
        assert.equal(await page.locator("#title").textContent(), "Test / 1");
        // A copied link works without a saved view; missing terminals fall back
        // cleanly, without trying to attach or enabling typing.
        await page.goto(`${origin}/?terminal=not-open`);
        await page.waitForFunction(() => document.getElementById("app")?.dataset.terminalState === "idle");
        assert.equal(await page.locator("#notice").textContent(), "Terminal closed.");
        assert.equal(new URL(page.url()).searchParams.has("terminal"), false);
        await page.goto(`${origin}/?terminal=${encodeURIComponent(terminal.address)}`);
        await page.waitForFunction(() => document.getElementById("app")?.dataset.terminalState === "watch");
        assert.equal(await page.locator("#title").textContent(), "Test / 1");
        await page.setViewportSize({ width: 844, height: 390 });
        await page.waitForFunction(() => (document.querySelector(".xterm-screen") as HTMLElement)?.offsetWidth > 500);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const landscape = await core.rpc("terminal.get", { terminal: terminal.address });
        assert.ok(landscape.cols > mobile.cols, "Rotation should resize the shared terminal");
        // Direct typing is the default after Control, without an extra composer.
        await page.locator("#mode").click();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForFunction(() => !(document.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement)?.readOnly);
        assert.equal(await page.locator("#compose").isVisible(), false);
        await page.locator(".xterm-helper-textarea").focus();
        assert.equal(await page.locator("#keys").isVisible(), false);
        assert.equal(await page.locator("#direct-shortcuts").isVisible(), true);
        await page.evaluate(() => document.documentElement.style.setProperty("--pocket-safe-bottom", "34px"));
        assert.equal(await page.locator("#app").evaluate(e => getComputedStyle(e).paddingBottom), "0px");
        await page.locator("#direct-shortcuts").click();
        assert.equal(await page.locator("#keys").isVisible(), true);
        assert.ok((await page.locator("#keys").boundingBox())!.height <= 30);
        assert.equal(await page.locator(".xterm-helper-textarea").evaluate(e => e === document.activeElement), true);
        await page.locator("#direct-shortcuts").click();
        assert.equal(await page.locator("#keys").isVisible(), false);
        await page.keyboard.type("default-direct-ok");
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("default-direct-ok"));
        // Composer remains an explicit alternative in the options menu.
        await page.locator("#terminal-menu summary").click();
        await page.locator("#keyboard").click();
        await page.locator("#compose").waitFor({ state: "visible" });
        assert.ok((await page.locator("#compose").boundingBox())!.height <= 52);
        assert.equal(await page.locator("#keys").isVisible(), false);
        assert.equal(await page.locator(".xterm-helper-textarea").evaluate((e: HTMLTextAreaElement) => e.readOnly), true);
        await page.locator("#message").focus();
        assert.equal(await page.locator("#keys").isVisible(), false);
        assert.equal(await page.locator("#notice").isVisible(), false);
        assert.equal(await page.locator("#fit").isVisible(), false);
        assert.equal(await page.locator("#keyboard").isVisible(), false);
        // Reproduce the small visual viewport above an iPhone software keyboard.
        await page.evaluate(`Object.defineProperty(window.visualViewport, "height", { configurable: true, get: () => 330 }); window.visualViewport.dispatchEvent(new Event("resize"));`);
        await page.waitForFunction(() => document.getElementById("app")?.clientHeight === 330);
        assert.ok((await page.locator("#terminal-scroll").boundingBox())!.height >= 230, "Typing chrome should leave most of the visual viewport for the terminal");
        assert.ok((await page.locator("#toolbar").boundingBox())!.height <= 40);
        await page.screenshot({ path: "/tmp/herdr-pocket-iphone-keyboard.png", clip: { x: 0, y: 0, width: 390, height: 330 } });
        await page.evaluate(() => {
          Reflect.deleteProperty(window.visualViewport!, "height");
          window.visualViewport!.dispatchEvent(new Event("resize"));
        });
        await page.locator("#message").focus();
        await page.locator("#show-keys").click();
        assert.equal(await page.locator("#keys").isVisible(), true);
        await page.locator("#message").fill("one\ntwo\nthree\nfour\nfive\nsix");
        const grown = (await page.locator("#message").boundingBox())!.height;
        assert.ok(grown > 60 && grown <= 100);
        await page.locator("#message").fill("compact-composer-ok");
        await page.locator("#message").press("Enter");
        await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("compact-composer-ok"));
        assert.equal(await page.locator("#message").inputValue(), "");
        assert.ok((await page.locator("#message").boundingBox())!.height <= 38);
        await page.locator("#message").fill("keep-this-draft");
        await page.screenshot({ path: "/tmp/herdr-pocket-typing.png" });
        await page.locator("#ctrl").click();
        await page.keyboard.type("u");
        assert.equal(await page.locator("#message").inputValue(), "keep-this-draft");
        assert.ok(typed.includes("\x15"));
        assert.equal(await page.locator("#ctrl").getAttribute("aria-pressed"), "false");
        await page.locator("#show-keys").click();
        assert.equal(await page.locator("#keys").isVisible(), false);
        await page.locator("#terminal-menu summary").click();
        await page.locator("#keyboard").click();
        assert.equal(await page.locator("#compose").isVisible(), false);
        assert.equal(await page.locator(".xterm-helper-textarea").evaluate((e: HTMLTextAreaElement) => e.readOnly), false);
        await page.keyboard.type("direct-keys-ok");
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("direct-keys-ok"));
        await page.locator("#terminal-menu summary").click();
        await page.locator("#keyboard").click();
        assert.equal(await page.locator("#message").inputValue(), "keep-this-draft");
        await page.locator("#message").evaluate((e: HTMLTextAreaElement) => e.blur());
        await page.waitForFunction(() => document.getElementById("keys")?.hidden);
        await page.waitForFunction(() => !document.body.classList.contains("typing"));
        assert.equal(await page.locator("#app").evaluate(e => getComputedStyle(e).paddingBottom), "34px");
        await page.evaluate(() => document.documentElement.style.removeProperty("--pocket-safe-bottom"));
        await page.locator("#mode").click();
        // Discover an update without forcing a refresh. Dismissal lasts this visit.
        await page.route("**/version.json", route => route.fulfill({ json: { version: "ffffffffffffffff" } }));
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await page.locator("#update-banner").waitFor({ state: "visible" });
        await page.locator("#update-later").click();
        const checkedAgain = page.waitForResponse("**/version.json");
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await checkedAgain;
        assert.equal(await page.locator("#update-banner").isVisible(), false);
        // A later build should be offered; explicit refresh restores view + draft,
        // the device's chosen input mode, never a submitted message.
        await page.unroute("**/version.json");
        await page.route("**/version.json", route => route.fulfill({ json: { version: "eeeeeeeeeeeeeeee" } }));
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await page.locator("#update-banner").waitFor({ state: "visible" });
        await page.locator("#mode").click();
        await page.waitForFunction(() => !(document.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement)?.readOnly);
        assert.equal(await page.locator("#compose").isVisible(), false);
        await page.locator("#terminal-menu summary").click();
        await page.locator("#keyboard").click();
        await page.locator("#compose").waitFor({ state: "visible" });
        await page.locator("#message").fill("unsent-pocket-draft");
        await page.unroute("**/version.json");
        await page.locator("#update-refresh").click();
        await page.waitForFunction(() => document.getElementById("app")?.dataset.terminalState === "control");
        assert.equal(await page.locator("#message").inputValue(), "unsent-pocket-draft");
        assert.equal(await page.locator("#compose").isVisible(), false);
        assert.equal(await page.locator("#mode").textContent(), "Watch");
        assert.equal(await page.locator(".xterm-helper-textarea").evaluate((e: HTMLTextAreaElement) => e.readOnly), false);
        assert.equal(await page.locator("#title").textContent(), "Test / 1");
        assert.equal(await page.locator("#update-banner").isVisible(), false);
        const afterUpdate = await core.rpc("terminal.read", { terminal: terminal.address, lines: 0 });
        assert.ok(!afterUpdate.text.includes("unsent-pocket-draft"), "Update must never submit a draft");
        assert.equal((await core.rpc("terminal.get", { terminal: terminal.address })).state, "live");
        // Browser refresh preserves Control preference, independent of URL flags.
        await page.waitForFunction(() => document.getElementById("app")?.dataset.terminalState === "control");
        await page.reload();
        await page.waitForFunction(() => document.getElementById("app")?.dataset.terminalState === "control");
        assert.equal(await page.locator("#title").textContent(), "Test / 1");
        assert.equal(await page.locator("#message").inputValue(), "unsent-pocket-draft");
        assert.equal(await page.locator(".xterm-helper-textarea").evaluate((e: HTMLTextAreaElement) => e.readOnly), false);
        // Creation from the phone opens the resulting terminal and updates the URL.
        await page.locator("#terminal-menu summary").click();
        await page.locator("#new-session-menu").click();
        await page.locator("#new-create").waitFor({ state: "visible" });
        await page.waitForFunction(() => !(document.getElementById("new-fields") as HTMLFieldSetElement).disabled);
        await page.locator("#new-program").selectOption("shell");
        await page.locator("#new-name").fill("From phone");
        await page.screenshot({ path: "/tmp/herdr-pocket-new-session.png" });
        await page.locator("#new-create").click();
        await page.locator("#new-dialog").waitFor({ state: "hidden" });
        await page.waitForFunction(() => document.getElementById("app")?.dataset.terminalState === "control");
        assert.equal(await page.locator("#title").textContent(), "Test / From phone");
        assert.notEqual(new URL(page.url()).searchParams.get("terminal"), terminal.address);
        await page.locator("#terminal-menu summary").click();
        await page.locator("#new-session-menu").click();
        await page.waitForFunction(() => !(document.getElementById("new-fields") as HTMLFieldSetElement).disabled);
        await page.locator("#new-program").selectOption("shell");
        await page.locator("#new-use-worktree").check();
        assert.equal(await page.locator("#new-repo").inputValue(), repo);
        await page.locator("#new-load-worktrees").click();
        await page.waitForFunction(() => document.querySelectorAll("#new-checkout option").length > 1);
        await page.locator("#new-branch").fill("ui/phone");
        await page.screenshot({ path: "/tmp/herdr-pocket-new-worktree.png" });
        await page.locator("#new-create").click();
        await page.locator("#new-dialog").waitFor({ state: "hidden" });
        await page.waitForFunction(() => document.getElementById("app")?.dataset.terminalState === "control");
        const calls = (await readFile(commandLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
        assert.ok(calls.at(-1).args.folder.endsWith("/repo-ui/ui-phone"));
        assert.equal(calls.at(-1).command, "space.new");
        // A fresh device defaults to Control, with no composer/shortcut rows.
        await page.evaluate(() => localStorage.removeItem("inputMode"));
        await page.reload();
        await page.waitForFunction(() => document.getElementById("app")?.dataset.terminalState === "control");
        assert.equal(await page.locator("#compose").isVisible(), false);
        assert.equal(await page.locator("#keys").isVisible(), false);
        const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSf0AAAAASUVORK5CYII=", "base64");
        const uploadResponse = page.waitForResponse(r => r.url().includes("/api/upload?") && r.request().method() === "POST");
        await page.locator("#terminal-menu summary").click();
        const chooser = page.waitForEvent("filechooser");
        await page.locator("#upload-file").click();
        await (await chooser).setFiles({ name: "clipboard.png", mimeType: "image/png", buffer: png });
        const uploaded = await (await uploadResponse).json();
        assert.deepEqual(await readFile(uploaded.path), png);
        await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("clipboard.png"));
        assert.ok(!typed.at(-1)!.endsWith("\r"), "Upload must not press Enter");
        // Clipboard API and native paste-event paths both stay on the target core.
        await page.evaluate(`Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{read:async()=>[{types:['image/png'],getType:async()=>new Blob([new Uint8Array(${JSON.stringify([...png])})],{type:'image/png'})}]}});`);
        const clipboardResponse = page.waitForResponse(r => r.url().includes("/api/upload?"));
        await page.locator("#terminal-menu summary").click();
        await page.locator("#paste-file").click();
        const clipboardFile = await (await clipboardResponse).json();
        assert.deepEqual(await readFile(clipboardFile.path), png);
        const pasteResponse = page.waitForResponse(r => r.url().includes("/api/upload?"));
        await page.locator(".xterm-helper-textarea").focus();
        await page.locator(".xterm-helper-textarea").evaluate((node, bytes) => {
          const data = new DataTransfer();
          data.items.add(new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" }));
          node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        }, [...png]);
        const pastedFile = await (await pasteResponse).json();
        assert.deepEqual(await readFile(pastedFile.path), png);
        // Full-screen apps enable mouse reporting: swipes must become wheel
        // input, without moving focus out of the keyboard textarea.
        const mouse = await core.rpc("terminal.run", { argv: ["/bin/sh", "-c", "printf '\\033[?1049h\\033[?1000h\\033[?1006hscroll target'; stty -echo -icanon min 1 time 0; cat"], no_parent: true, no_notify: true });
        const mouseWorld = JSON.parse(await readFile(worldFile, "utf8"));
        mouseWorld.spaces[0].tabs.push({ id: "mouse", name: "Mouse", terminals: [{ terminal: mouse.address, sub_agents: [] }] });
        await writeFile(worldFile, JSON.stringify(mouseWorld));
        await page.goto(`${origin}/?terminal=${mouse.address}`);
        await page.waitForFunction(() => document.getElementById("app")?.dataset.terminalState === "control");
        await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("scroll target"));
        await page.locator(".xterm-helper-textarea").focus();
        const beforeWheel = typed.length;
        await page.locator(".xterm-screen").evaluate(node => {
          const rect = node.getBoundingClientRect();
          node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, clientX: rect.left + 20, clientY: rect.top + 40, bubbles: true, cancelable: true }));
        });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.ok(typed.slice(beforeWheel).some(s => s.includes("\x1b[<64;")), "Mouse wheel precondition should work");
        const beforeSwipe = typed.length;
        const swipeTerminal = () => page.evaluate(`{
          const node = document.querySelector('.xterm-screen'), rect = node.getBoundingClientRect();
          const start = new Touch({identifier:1,target:node,clientX:rect.left+30,clientY:rect.top+60});
          const end = new Touch({identifier:1,target:node,clientX:rect.left+30,clientY:rect.top+140});
          node.dispatchEvent(new TouchEvent('touchstart',{touches:[start],changedTouches:[start],bubbles:true,cancelable:true}));
          node.dispatchEvent(new TouchEvent('touchmove',{touches:[end],changedTouches:[end],bubbles:true,cancelable:true}));
          node.dispatchEvent(new TouchEvent('touchend',{touches:[],changedTouches:[end],bubbles:true,cancelable:true}));
        }`);
        await swipeTerminal();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.ok(typed.slice(beforeSwipe).some(s => s.includes("\x1b[<64;")), "Touch swipes must scroll mouse-enabled apps");
        assert.equal(await page.locator(".xterm-helper-textarea").evaluate(node => node === document.activeElement), true);
        await page.evaluate(`Object.defineProperty(window.visualViewport, 'height', {configurable:true,get:()=>330}); window.visualViewport.dispatchEvent(new Event('resize'));`);
        await page.evaluate(`Object.defineProperty(window.visualViewport, 'height', {configurable:true,get:()=>550}); window.visualViewport.dispatchEvent(new Event('resize'));`);
        assert.equal(await page.locator(".xterm-helper-textarea").evaluate(node => node === document.activeElement), true, "Viewport changes must not dismiss input focus");
        await page.evaluate(() => { Reflect.deleteProperty(window.visualViewport!, "height"); window.visualViewport!.dispatchEvent(new Event("resize")); });
        const plain = await core.rpc("terminal.run", { argv: ["/bin/sh", "-c", "i=0; while [ $i -lt 120 ]; do printf 'line-%03d\\n' $i; i=$((i+1)); done; stty -echo -icanon min 1 time 0; cat"], no_parent: true, no_notify: true });
        const plainWorld = JSON.parse(await readFile(worldFile, "utf8"));
        plainWorld.spaces[0].tabs.push({ id: "plain", name: "Plain", terminals: [{ terminal: plain.address, sub_agents: [] }] });
        await writeFile(worldFile, JSON.stringify(plainWorld));
        await page.goto(`${origin}/?terminal=${plain.address}`);
        await page.waitForFunction(() => document.getElementById("app")?.dataset.terminalState === "control");
        await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("line-119"));
        await page.locator(".xterm-helper-textarea").focus();
        const beforeLocalScroll = await page.locator(".xterm-viewport").evaluate(node => node.scrollTop);
        assert.ok(beforeLocalScroll > 0);
        await swipeTerminal();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.ok(await page.locator(".xterm-viewport").evaluate(node => node.scrollTop) < beforeLocalScroll, "Normal scrollback swipes should scroll locally");
        assert.equal(await page.locator(".xterm-helper-textarea").evaluate(node => node === document.activeElement), true);
        await page.keyboard.type("after-scroll");
        await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("after-scroll"));
        // Explicit Watch choice persists across refresh and disables upload input.
        await page.locator("#mode").click();
        await page.waitForFunction(() => document.getElementById("app")?.dataset.terminalState === "watch");
        await page.reload();
        await page.waitForFunction(() => document.getElementById("app")?.dataset.terminalState === "watch");
        assert.equal(await page.locator("#upload-file").isDisabled(), true);
      } finally { await browser.close(); }
    }
    const post = (path: string, value: object, extra: Record<string, string> = {}) => fetch(`${origin}${path}`, { method: "POST", headers: { origin, cookie, "Content-Type": "application/json", ...extra }, body: JSON.stringify(value) });
    const payload = { requestId: randomUUID(), kind: "session", program: "shell", space: "s1", name: "API test" };
    const beforeCalls = (await readFile(commandLog, "utf8")).trim().split("\n").filter(Boolean).length;
    assert.equal((await post("/api/sessions", payload, { origin: "https://attacker.test" })).status, 403);
    assert.equal((await post("/api/sessions", payload, { cookie: "" })).status, 401);
    assert.equal((await post("/api/sessions", { ...payload, argv: ["bad"] })).status, 400);
    const [first, duplicate] = await Promise.all([post("/api/sessions", payload), post("/api/sessions", payload)]);
    assert.equal(first.status, 201); assert.equal(duplicate.status, 201);
    const created = await first.json();
    assert.deepEqual(await duplicate.json(), created);
    assert.equal((await core.rpc("terminal.get", { terminal: created.terminal })).state, "live");
    assert.equal((await readFile(commandLog, "utf8")).trim().split("\n").filter(Boolean).length, beforeCalls + 1);
    assert.equal((await post("/api/sessions", { ...payload, name: "Changed" })).status, 409);
    const wtRequest = { requestId: randomUUID(), kind: "worktree-new", program: "shell", repo, branch: "api/phone" };
    const wtResponse = await post("/api/sessions", wtRequest);
    assert.equal(wtResponse.status, 201);
    const wt = await wtResponse.json();
    assert.ok(wt.worktree.startsWith(env.HOME + "/.herdr/worktrees/"));
    const listed = await (await post("/api/worktrees", { repo })).json();
    assert.ok(listed.worktrees.some((w: any) => w.branch === "api/phone" && w.path === wt.worktree));
    const reopen = await post("/api/sessions", { requestId: randomUUID(), kind: "worktree-open", program: "shell", repo, path: wt.worktree });
    assert.equal(reopen.status, 201);
    const last = (await readFile(commandLog, "utf8")).trim().split("\n").map(line => JSON.parse(line)).at(-1);
    assert.equal(last.command, "tab.new");
    const uploadUrl = `${origin}/api/upload?terminal=${created.terminal}&name=..%2Fimage.png`;
    const uploadHeaders = { origin, cookie, "Content-Type": "application/octet-stream" };
    assert.equal((await fetch(uploadUrl, { method: "POST", headers: { ...uploadHeaders, cookie: "" }, body: "file" })).status, 401);
    assert.equal((await fetch(uploadUrl, { method: "POST", headers: { ...uploadHeaders, origin: "https://attacker.test" }, body: "file" })).status, 403);
    const fileResponse = await fetch(uploadUrl, { method: "POST", headers: uploadHeaders, body: "file-data" });
    assert.equal(fileResponse.status, 201);
    const file = await fileResponse.json();
    assert.equal(await readFile(file.path, "utf8"), "file-data");
    assert.ok(file.path.endsWith("/image.png"));
    assert.equal((await fetch(`${origin}/api/upload?terminal=not-open`, { method: "POST", headers: uploadHeaders, body: "file" })).status, 404);
  } finally {
    for (const ws of sockets) ws.terminate();
    if (server) { const exited = once(server, "exit"); server.kill(); await exited; }
    // Only this test's isolated core, never the user's runtime.
    try { await core.rpc("server.stop"); } catch {}
    core.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
