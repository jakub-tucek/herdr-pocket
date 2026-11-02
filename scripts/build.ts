import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile, copyFile } from "node:fs/promises";

const hash = createHash("sha256");
for (const file of ["scripts/build.ts", "web/app.ts", "web/updates.ts", "web/typing.ts", "web/navigation.ts", "web/sessions.ts", "web/files.ts", "web/touch.ts", "upload-format.ts", "sessions.ts", "server.ts", "core.ts", "auth.ts", "model.ts", "pnpm-lock.yaml", "public/index.html", "public/style.css", "public/sw.js", "public/manifest.webmanifest", "public/icon.svg", "public/icon-192.png", "public/icon-512.png"]) {
  hash.update(file).update(await readFile(file));
}
const version = hash.digest("hex").slice(0, 16);
await build({ entryPoints: ["web/app.ts"], bundle: true, format: "esm", minify: true, outfile: "public/app.js", define: { __BUILD_ID__: JSON.stringify(version) } });
await copyFile("node_modules/@xterm/xterm/css/xterm.css", "public/xterm.css");
// Publish the marker only once the matching bundle is complete.
await writeFile("public/version.json", `${JSON.stringify({ version })}\n`);
console.log(`Built Herdr Pocket ${version}`);
