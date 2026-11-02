import { timingSafeEqual } from "node:crypto";

export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function cookie(req: Request, name: string): string {
  return req.headers.get("cookie")?.split(";").map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1) || "";
}

export function trustedRequest(req: Request, hosts: Set<string>): boolean {
  const host = req.headers.get("host");
  if (!host || !hosts.has(host)) return false;
  const origin = req.headers.get("origin");
  if (!origin) return ["GET", "HEAD"].includes(req.method) && req.headers.get("upgrade")?.toLowerCase() !== "websocket";
  // Public Tailscale traffic terminates HTTPS before reaching the loopback bridge.
  return origin === `https://${host}` || (host.startsWith("127.0.0.1:") || host.startsWith("localhost:")) && origin === `http://${host}`;
}
