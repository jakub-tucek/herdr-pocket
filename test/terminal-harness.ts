import { attachTerminal } from "../src/terminal";
await attachTerminal({ address: process.argv[2], title: "Phone terminal" });
console.log("POCKET-DETACHED");
