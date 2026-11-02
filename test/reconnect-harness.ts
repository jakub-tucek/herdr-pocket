import { Backend, type Launch } from "../src/backend";
import type { Repository, World } from "../src/model";
import { Tui } from "../src/tui";

class ReconnectBackend extends Backend {
  worldCalls = 0;
  discoveries: { worldCalls: number; at: number }[] = [];
  launches: { input: Launch; worldCalls: number; discoveries: number }[] = [];
  override async world(): Promise<World> {
    this.worldCalls++;
    if (this.worldCalls === 2) throw new Error("Controlled refresh failure");
    return {
      machines: [{ name: "test-host", state: "connected" }],
      terminals: [],
      spaces: [{ id: "test-host/space", localId: "space", name: "Test space", machine: "test-host", folder: "/projects/repo", workspaceFolder: "/projects/repo", tabs: [], online: true }],
    };
  }
  override async repositories(): Promise<Repository[]> {
    this.discoveries.push({ worldCalls: this.worldCalls, at: Date.now() });
    return [{ id: "test-repo", name: this.discoveries.length === 1 ? "Original repo" : "Recovered repo", machine: "test-host", folder: "/projects/repo", commonDir: "/projects/repo/.git", checkouts: [{ path: "/projects/repo", branch: "main" }], spaceIds: ["test-host/space"], online: true }];
  }
  override async launch(input: Launch): ReturnType<Backend["launch"]> {
    this.launches.push({ input, worldCalls: this.worldCalls, discoveries: this.discoveries.length });
    // Record dispatch without attaching a real terminal or starting a core.
    throw new Error("Controlled shell launch accepted");
  }
}

const backend = new ReconnectBackend();
await new Tui(backend).run();
console.log("RECONNECT-COUNTERS " + JSON.stringify({ worldCalls: backend.worldCalls, discoveries: backend.discoveries, launches: backend.launches }));
