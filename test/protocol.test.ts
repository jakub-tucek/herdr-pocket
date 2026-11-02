import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FrameDecoder, frame } from "../core";
import { sameSecret, trustedRequest } from "../auth";
import { terminalAllowed } from "../model";

describe("wire protocol", () => {
  it("decodes fragmented and coalesced frames, including UTF-8", () => {
    const decoder = new FrameDecoder(), output: any[] = [];
    const data = Buffer.concat([frame(7, 0, Buffer.from("héllo")), frame(7, 3, Buffer.from([80, 0, 24, 0]))]);
    for (const byte of data) decoder.push(Buffer.from([byte]), (...args) => output.push(args));
    assert.deepEqual(output.map(([ch, kind, bytes]) => [ch, kind, [...bytes]]), [[7, 0, [...Buffer.from("héllo")]], [7, 3, [80, 0, 24, 0]]]);
  });
  it("rejects oversized payloads", () => {
    const header = Buffer.alloc(9); header.writeUInt32LE(20 << 20, 5);
    assert.throws(() => new FrameDecoder().push(header, () => {}), /Oversized/);
  });
});
describe("access boundaries", () => {
  const hosts = new Set(["127.0.0.1:8790", "host.example.invalid"]);
  const req = (host: string, origin?: string, upgrade?: string) => new Request(`http://${host}/`, { headers: { host, ...(origin ? { origin } : {}), ...(upgrade ? { upgrade } : {}) } });
  it("rejects DNS rebinding, cross-origin and origin-less websocket requests", () => {
    assert.equal(trustedRequest(req("attacker.test"), hosts), false);
    assert.equal(trustedRequest(req("host.example.invalid", "https://attacker.test"), hosts), false);
    assert.equal(trustedRequest(req("host.example.invalid", undefined, "websocket"), hosts), false);
    assert.equal(trustedRequest(req("host.example.invalid", "http://host.example.invalid"), hosts), false);
    assert.equal(trustedRequest(req("host.example.invalid", "https://host.example.invalid"), hosts), true);
    assert.equal(trustedRequest(req("127.0.0.1:8790", "http://127.0.0.1:8790"), hosts), true);
  });
  it("checks secrets and terminal allowlist", () => {
    assert.equal(sameSecret("abc", "abc"), true);
    assert.equal(sameSecret("abc", "ab"), false);
    const world: any = { spaces: [{ tabs: [{ terminals: [{ terminal: "t1", sub_agents: ["remote/t3"] }] }] }] };
    assert.equal(terminalAllowed(world, "t1"), true);
    assert.equal(terminalAllowed(world, "remote/t3"), true);
    assert.equal(terminalAllowed(world, "t2"), false);
  });
});
