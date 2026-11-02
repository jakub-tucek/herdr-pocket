import { mkdir, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const bin = join(homedir(), ".local/bin");
await mkdir(bin, { recursive: true });
const launcher = join(bin, "herdr-pocket");
await writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(root, "dist/main.js"))} "$@"\n`);
await chmod(launcher, 0o755);
console.log(`Installed ${launcher}`);
