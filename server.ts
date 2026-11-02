import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { Core, Kind } from "./core";
import { cookie, sameSecret, trustedRequest } from "./auth";
import { readWorld, terminalAllowed } from "./model";
import { withRuntime, parseLaunch, parseWorktreeLookup, listWorktrees, launchSession } from "./sessions";
import { MAX_UPLOAD, uploadName } from "./upload-format";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8790);
const state = process.env.POCKET_STATE || `${process.env.HOME}/.config/herdr-pocket`;
await mkdir(state, { recursive: true, mode: 0o700 });
const tokenPath = join(state, "pairing-key");
let token: string;
try { token = (await readFile(tokenPath, "utf8")).trim(); }
catch (e: any) {
  if (e.code !== "ENOENT") throw e;
  token = randomBytes(32).toString("base64url");
  await writeFile(tokenPath, token, { mode: 0o600, flag: "wx" });
}
if (token.length < 32) throw new Error("Invalid pairing key");
const session = createHmac("sha256", token).update("herdr-pocket-session-v1").digest("base64url");
const publicHost = process.env.POCKET_HOST;
const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...(publicHost ? [publicHost] : [])]);
const authorized = (req: Request) => sameSecret(cookie(req, "pocket"), session);
const headers = {
  "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
let worldRead: ReturnType<typeof readWorld> | undefined;
function world() { return worldRead ||= readWorld().finally(() => { worldRead = undefined; }); }
const attempts = new Map<string, { count: number; until: number }>();
const creations = new Map<string, { fingerprint: string; at: number; result: Promise<{ status: number; value: unknown }> }>();
let uploads = 0;
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]], ["/app.js", ["app.js", "text/javascript"]],
  ["/style.css", ["style.css", "text/css"]], ["/xterm.css", ["xterm.css", "text/css"]],
  ["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json"]],
  ["/icon.svg", ["icon.svg", "image/svg+xml"]], ["/sw.js", ["sw.js", "text/javascript"]],
  ["/icon-192.png", ["icon-192.png", "image/png"]], ["/icon-512.png", ["icon-512.png", "image/png"]],
  ["/version.json", ["version.json", "application/json"]],
]);
type Connection = {
  terminal: string; control: boolean; fit: boolean; cols: number; rows: number;
  core?: Core; channel?: number; closed?: boolean; sizeTimer?: ReturnType<typeof setInterval>;
  outstanding: number;
};
type Viewer = WebSocket & { data: Connection };
function notify(ws: Viewer, value: unknown) {
  if (!ws.data.closed && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
}
function end(ws: Viewer) {
  ws.data.closed = true; clearInterval(ws.data.sizeTimer); ws.data.core?.close();
}
const validSize = (v: unknown) => Number.isInteger(v) && Number(v) >= 2 && Number(v) <= 500;
function request(req: IncomingMessage) {
  const h = new Headers();
  for (const [key, value] of Object.entries(req.headers)) if (value) h.set(key, Array.isArray(value) ? value.join(", ") : value);
  return new Request(`http://${req.headers.host || "localhost"}${req.url || "/"}`, { method: req.method, headers: h });
}
async function body(req: IncomingMessage) {
  let length = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 8192) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function route(req: Request, incoming: IncomingMessage): Promise<Response> {
  if (!trustedRequest(req, hosts)) return json({ error: "Untrusted host or origin" }, 403);
  const url = new URL(req.url);
  if (url.pathname === "/api/login" && req.method === "POST") {
    const key = incoming.socket.remoteAddress || "loopback", now = Date.now();
    let attempt = attempts.get(key);
    if (!attempt || attempt.until < now) { attempt = { count: 0, until: now + 60_000 }; attempts.set(key, attempt); }
    if (++attempt.count > 10) return json({ error: "Too many attempts. Wait one minute." }, 429);
    let value: any;
    try { value = await body(incoming); } catch { return json({ error: "Invalid request" }, 400); }
    if (typeof value.key !== "string" || !sameSecret(value.key, token)) return json({ error: "Wrong pairing key" }, 401);
    const secure = req.headers.get("host") === publicHost ? "; Secure" : "";
    return new Response("{}", { headers: { ...headers, "Content-Type": "application/json", "Set-Cookie": `pocket=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}` } });
  }
  if (url.pathname === "/api/logout" && req.method === "POST") {
    return new Response("{}", { headers: { ...headers, "Set-Cookie": "pocket=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" } });
  }
  if (url.pathname.startsWith("/api/") || url.pathname === "/terminal") {
    if (!authorized(req)) return json({ error: "Pair this device first" }, 401);
    if (url.pathname === "/api/world" && req.method === "GET") {
      try { return json(await world()); } catch (e: any) { return json({ error: e.message }, 503); }
    }
    if (url.pathname === "/api/upload" && req.method === "POST") {
      const terminal = url.searchParams.get("terminal") || "";
      if (uploads >= 3) { incoming.resume(); return json({ error: "Upload busy. Try again." }, 429); }
      const size = Number(incoming.headers["content-length"]);
      if (size > MAX_UPLOAD) { incoming.resume(); return json({ error: "File too large (8 MB maximum)." }, 413); }
      if (!terminalAllowed(await world(), terminal)) { incoming.resume(); return json({ error: "Terminal closed." }, 404); }
      if (uploads >= 3) { incoming.resume(); return json({ error: "Upload busy. Try again." }, 429); }
      uploads++;
      let core: Core | undefined;
      try {
        let length = 0; const chunks: Buffer[] = [];
        for await (const chunk of incoming) {
          length += chunk.length;
          if (length > MAX_UPLOAD) throw new Error("File too large (8 MB maximum).");
          chunks.push(chunk);
        }
        core = new Core();
        const result = await core.rpc("terminal.put", { terminal, name: uploadName(url.searchParams.get("name") || "file"), data: Buffer.concat(chunks).toString("base64") }, 70_000);
        return json(result, 201);
      } catch (e: any) { return json({ error: e.message || "Upload failed." }, 400); }
      finally { uploads--; core?.close(); }
    }
    if (url.pathname === "/api/session-options" && req.method === "GET") {
      try {
        return json(await withRuntime(async runtime => {
          const [machines, snapshot] = await Promise.all([runtime.machines(), runtime.world()]);
          return { machines: machines.filter(m => !m.temporary).map(m => ({ name: m.name, state: m.state })), spaces: snapshot.spaces };
        }));
      } catch (e: any) { return json({ error: e.message }, 503); }
    }
    if (url.pathname === "/api/worktrees" && req.method === "POST") {
      try {
        const input = parseWorktreeLookup(await body(incoming));
        return json({ worktrees: await withRuntime(runtime => listWorktrees(runtime, input.machine, input.repo)) });
      } catch (e: any) { return json({ error: e.message }, 400); }
    }
    if (url.pathname === "/api/sessions" && req.method === "POST") {
      try {
        const value = await body(incoming), input = parseLaunch(value);
        if (typeof value.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(value.requestId)) return json({ error: "Invalid request ID." }, 400);
        const fingerprint = JSON.stringify(input), now = Date.now();
        for (const [id, job] of creations) if (now - job.at > 600_000) creations.delete(id);
        let job = creations.get(value.requestId);
        if (job && job.fingerprint !== fingerprint) return json({ error: "Request ID already used." }, 409);
        if (!job) {
          if (creations.size >= 100) return json({ error: "Too many requests. Try later." }, 429);
          job = { fingerprint, at: now, result: withRuntime(runtime => launchSession(runtime, input))
            .then(created => { worldRead = undefined; return { status: 201, value: created }; })
            .catch((e: any) => ({ status: 400, value: { error: e.message } })) };
          creations.set(value.requestId, job);
        }
        const result = await job.result;
        return json(result.value, result.status);
      } catch (e: any) { return json({ error: e.message }, 400); }
    }
    return json({ error: "Not found" }, 404);
  }
  const file = files.get(url.pathname);
  if (file && ["GET", "HEAD"].includes(req.method)) {
    try { return new Response(await readFile(join(root, "public", file[0])), { headers: { ...headers, "Content-Type": file[1] } }); }
    catch { return json({ error: "Asset missing. Run pnpm build." }, 503); }
  }
  return json({ error: "Not found" }, 404);
}
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const server = createServer(async (incoming, outgoing) => {
  try {
    const response = await route(request(incoming), incoming);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch { outgoing.writeHead(500, headers); outgoing.end("Request failed"); }
});
server.on("upgrade", async (incoming, socket, head) => {
  const reject = (code: number) => { socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\n\r\n`); };
  socket.on("error", () => {});
  try {
    const req = request(incoming), url = new URL(req.url);
    if (!trustedRequest(req, hosts)) return reject(403);
    if (!authorized(req)) return reject(401);
    if (url.pathname !== "/terminal") return reject(404);
    const terminal = url.searchParams.get("id") || "";
    const cols = Number(url.searchParams.get("cols")), rows = Number(url.searchParams.get("rows"));
    if (!validSize(cols) || !validSize(rows)) return reject(400);
    if (!terminalAllowed(await world(), terminal)) return reject(404);
    if (socket.destroyed) return;
    wss.handleUpgrade(incoming, socket, head, ws => {
      const viewer = ws as Viewer;
      viewer.data = { terminal, cols, rows, control: url.searchParams.get("control") === "1", fit: url.searchParams.get("fit") === "1", outstanding: 0 };
      wss.emit("connection", viewer);
    });
  } catch { reject(503); }
});
wss.on("connection", async (socket) => {
  const ws = socket as Viewer, d = ws.data, core = d.core = new Core();
  const early: [number, number, Buffer][] = []; let earlyBytes = 0;
  ws.on("error", () => end(ws));
  ws.on("close", () => end(ws));
  ws.on("message", (raw, binary) => {
    try {
      if (binary) throw new Error("Expected JSON");
      const m = JSON.parse(raw.toString());
      if (m.type === "ping") { notify(ws, { type: "pong" }); return; }
      if (d.channel === undefined) return;
      if (m.type === "credit" && Number.isInteger(m.bytes) && m.bytes > 0 && m.bytes <= d.outstanding) {
        d.outstanding -= m.bytes; core.credit(d.channel, m.bytes);
      } else if (d.control && m.type === "input" && typeof m.text === "string" && Buffer.byteLength(m.text) <= 16384) {
        core.send(d.channel, Kind.DATA, Buffer.from(m.text));
      } else if ((d.control || d.fit) && m.type === "resize" && validSize(m.cols) && validSize(m.rows)) {
        const size = Buffer.alloc(4); size.writeUInt16LE(m.cols); size.writeUInt16LE(m.rows, 2);
        core.send(d.channel, Kind.RESIZE, size);
      } else throw new Error("Invalid terminal message");
    } catch { ws.close(1008, "Invalid message"); end(ws); }
  });
  const deliver = (channel: number, kind: number, payload: Buffer) => {
    if (d.closed || channel !== d.channel) return;
    if (kind === Kind.DATA) {
      d.outstanding += payload.length;
      if (d.outstanding > 512 * 1024 || ws.bufferedAmount > 1 << 20) { ws.close(1013, "Viewer too slow"); end(ws); return; }
      ws.send(payload);
    } else if (kind === Kind.RESIZE && payload.length === 4) {
      notify(ws, { type: "size", cols: payload.readUInt16LE(0), rows: payload.readUInt16LE(2) });
    } else if (kind === Kind.CLOSE) { ws.close(1000, "Terminal stream ended"); end(ws); }
  };
  core.on("frame", (channel, kind, payload) => {
    if (d.channel === undefined) {
      earlyBytes += payload.length;
      if (earlyBytes > 512 * 1024) { ws.close(1013); end(ws); return; }
      early.push([channel, kind, payload]);
    } else deliver(channel, kind, payload);
  });
  core.on("disconnect", () => { if (!d.closed) { ws.close(1011, "Core disconnected"); end(ws); } });
  try {
    const result = await core.rpc("terminal.attach", { terminal: d.terminal, cols: d.cols, rows: d.rows, observe: !(d.control || d.fit), resize_notifications: true, history: 500 });
    if (d.closed) return;
    d.channel = result.channel;
    notify(ws, { type: "ready", control: d.control, fit: d.fit, cols: result.terminal.cols, rows: result.terminal.rows });
    for (const args of early) deliver(...args);
    // Older remote cores do not relay resize frames. Track their grid explicitly.
    if (!d.control && !d.fit && !result.resize_notifications) {
      let busy = false;
      const { cols, rows } = result.terminal;
      d.sizeTimer = setInterval(async () => {
        if (busy || d.closed) return;
        busy = true;
        try {
          const t = await core.rpc("terminal.get", { terminal: d.terminal });
          // Old relays cannot order a resize before a replacement paint. A new
          // observer attach gives an authoritative grid + paint, without resizing.
          if (t.cols !== cols || t.rows !== rows) { ws.close(1000, "Desktop resized; refreshing view"); end(ws); }
        }
        catch { ws.close(1011); end(ws); }
        finally { busy = false; }
      }, 2000);
    }
  } catch (e: any) { notify(ws, { type: "error", message: e.message }); ws.close(1011); end(ws); }
});
// Bound half-open mobile connections, including those suspended without a close frame.
const alive = new WeakSet<WebSocket>();
wss.on("connection", ws => { alive.add(ws); ws.on("pong", () => alive.add(ws)); });
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) { ws.terminate(); continue; }
    alive.delete(ws); ws.ping();
  }
}, 30000);
server.listen(port, "127.0.0.1", () => {
  console.log(`Herdr Pocket: http://127.0.0.1:${port}`);
  console.log(`Pairing key: ${tokenPath} (not logged)`);
});
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  clearInterval(heartbeat);
  for (const ws of wss.clients) { end(ws as Viewer); ws.terminate(); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});
