import type { Created, Checkout } from "../sessions";
import type { Space } from "../model";

type Options = { spaces: Space[]; machines: { name: string; state: string }[] };
export function sessionControls(api: (path: string, body?: object) => Promise<any>, current: () => string | undefined, opened: (created: Created) => Promise<void>) {
  const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = get<HTMLDialogElement>("new-dialog"), form = get<HTMLFormElement>("new-form");
  const space = get<HTMLSelectElement>("new-space"), machine = get<HTMLSelectElement>("new-machine"), program = get<HTMLSelectElement>("new-program");
  const folder = get<HTMLInputElement>("new-folder"), repo = get<HTMLInputElement>("new-repo"), branch = get<HTMLInputElement>("new-branch");
  const worktree = get<HTMLInputElement>("new-use-worktree"), checkout = get<HTMLSelectElement>("new-checkout");
  const submit = get<HTMLButtonElement>("new-create"), cancel = get<HTMLButtonElement>("new-cancel"), error = get("new-error");
  let options: Options = { spaces: [], machines: [] }, busy = false, requestId = crypto.randomUUID();
  const option = (value: string, label: string) => new Option(label, value);
  const onMachine = () => options.spaces.find(s => s.id === space.value)?.machine || (space.value ? "" : machine.value);
  const lookupKey = () => `${onMachine()}\0${repo.value.trim()}`;
  function update() {
    get("new-machine-row").hidden = !!space.value;
    get("new-folder-row").hidden = worktree.checked;
    get("new-worktree-fields").hidden = !worktree.checked;
    const creating = worktree.checked && checkout.value === "new";
    get("new-branch-row").hidden = !creating;
    get("new-base-row").hidden = !creating;
    repo.required = worktree.checked;
    branch.required = creating;
    submit.textContent = busy ? "Creating…" : "Create";
    submit.disabled = busy; cancel.disabled = busy;
    get<HTMLFieldSetElement>("new-fields").disabled = busy;
  }
  function resetLookup() { checkout.replaceChildren(option("new", "New worktree")); update(); }
  async function open() {
    if (busy) return;
    get<HTMLDetailsElement>("terminal-menu").open = false;
    form.reset(); error.textContent = ""; requestId = crypto.randomUUID();
    resetLookup(); dialog.showModal();
    busy = true; update();
    try {
      options = await api("/api/session-options");
      space.replaceChildren(option("", "New space"), ...options.spaces.map(s => option(s.id, `${s.machine || "Mac"} / ${s.name}`)));
      machine.replaceChildren(option("", "Mac"), ...options.machines.map(m => {
        const o = option(m.name, m.name + (m.state === "connected" ? "" : " · offline")); o.disabled = m.state !== "connected"; return o;
      }));
      const active = options.spaces.find(s => s.tabs.some(t => t.terminals.some(p => p.terminal === current() || p.sub_agents.includes(current() || ""))));
      space.value = active?.id || "";
      folder.value = active?.folder || ""; repo.value = active?.folder || "";
    } catch (e: any) { error.textContent = e.message; }
    finally { busy = false; update(); }
  }
  get("new-session").addEventListener("click", () => void open());
  get("new-session-menu").addEventListener("click", () => void open());
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  space.addEventListener("change", () => {
    const selected = options.spaces.find(s => s.id === space.value);
    folder.value = selected?.folder || ""; repo.value = selected?.folder || ""; resetLookup();
  });
  machine.addEventListener("change", () => { folder.value = ""; repo.value = ""; resetLookup(); });
  repo.addEventListener("input", resetLookup);
  worktree.addEventListener("change", () => { if (worktree.checked && !repo.value) repo.value = folder.value; update(); });
  checkout.addEventListener("change", update);
  form.addEventListener("input", () => { requestId = crypto.randomUUID(); error.textContent = ""; });
  form.addEventListener("change", () => { requestId = crypto.randomUUID(); error.textContent = ""; });
  get("new-load-worktrees").addEventListener("click", async () => {
    const key = lookupKey(), button = get<HTMLButtonElement>("new-load-worktrees");
    button.disabled = true; error.textContent = "";
    try {
      const result = await api("/api/worktrees", { machine: onMachine(), repo: repo.value });
      if (key !== lookupKey()) return;
      checkout.replaceChildren(option("new", "New worktree"), ...result.worktrees.map((c: Checkout) => option(c.path, c.branch || c.path)));
      update();
    } catch (e: any) { error.textContent = e.message; }
    finally { button.disabled = false; }
  });
  form.addEventListener("submit", async event => {
    event.preventDefault(); if (busy) return;
    busy = true; update(); error.textContent = "";
    try {
      const result = await api("/api/sessions", {
        requestId, kind: worktree.checked ? checkout.value === "new" ? "worktree-new" : "worktree-open" : "session",
        program: program.value, space: space.value, machine: onMachine(), folder: worktree.checked ? "" : folder.value,
        name: get<HTMLInputElement>("new-name").value, repo: worktree.checked ? repo.value : "",
        branch: worktree.checked && checkout.value === "new" ? branch.value : "",
        base: get<HTMLInputElement>("new-base").value,
        path: worktree.checked && checkout.value !== "new" ? checkout.value : "",
      });
      await opened(result); dialog.close();
    } catch (e: any) { error.textContent = e.message; }
    finally { busy = false; update(); }
  });
}
