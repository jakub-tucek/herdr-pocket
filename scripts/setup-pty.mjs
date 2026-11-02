import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chmodSync, existsSync } from "node:fs";

// node-pty 1.1.0's macOS prebuild helper is published without its executable bit.
if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("node-pty/package.json"));
  for (const helper of [join(root, "prebuilds", `darwin-${process.arch}`, "spawn-helper"), join(root, "build/Release/spawn-helper")]) {
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
