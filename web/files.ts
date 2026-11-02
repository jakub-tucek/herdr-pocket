import { MAX_UPLOAD, pastedPaths } from "../upload-format";

export function fileControls(target: () => string | undefined, pasted: (terminal: string, text: string) => void, status: (text?: string) => void) {
  const picker = document.getElementById("upload-input") as HTMLInputElement;
  const pickButton = document.getElementById("upload-file") as HTMLButtonElement;
  const pasteButton = document.getElementById("paste-file") as HTMLButtonElement;
  let busy = false, pickerTarget: string | undefined;
  const update = () => { pickButton.disabled = busy || !target(); pasteButton.disabled = busy || !target(); };
  function closeMenu() { (document.getElementById("terminal-menu") as HTMLDetailsElement).open = false; }
  async function upload(files: File[], terminal = target()) {
    if (!terminal || !files.length) return;
    if (busy) { status("Upload in progress."); return; }
    if (files.length > 8) { status("Upload up to 8 files at once."); return; }
    if (files.some(file => file.size > MAX_UPLOAD)) { status("File too large (8 MB maximum)."); return; }
    busy = true; update(); closeMenu();
    status("Uploading…");
    const paths: string[] = [];
    try {
      for (const file of files) {
        const query = new URLSearchParams({ terminal, name: file.name });
        const response = await fetch(`/api/upload?${query}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || "Upload failed.");
        paths.push(value.path);
      }
      status();
      pasted(terminal, pastedPaths(paths));
    } catch (e: any) {
      // Keep completed uploads usable even if another file in the batch fails.
      if (paths.length) pasted(terminal, pastedPaths(paths));
      status(e.message);
    } finally { busy = false; update(); picker.value = ""; }
  }
  pickButton.addEventListener("click", () => { if (target() && !busy) { pickerTarget = target(); closeMenu(); picker.click(); } });
  picker.addEventListener("change", () => void upload(Array.from(picker.files || []), pickerTarget || target()));
  pasteButton.addEventListener("click", async () => {
    const terminal = target();
    if (!terminal || busy) return;
    closeMenu();
    try {
      if (!navigator.clipboard?.read) throw new Error("Use Upload file on this browser.");
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      for (const item of items) {
        const type = item.types.find(t => t.startsWith("image/")) || item.types.find(t => !t.startsWith("text/"));
        if (!type) continue;
        const blob = await item.getType(type);
        const extension = type === "image/jpeg" ? "jpg" : type.split("/").at(-1)?.replace(/[^a-z0-9]/gi, "") || "bin";
        files.push(new File([blob], `clipboard.${extension}`, { type }));
      }
      if (!files.length) throw new Error("No file in clipboard.");
      await upload(files, terminal);
    } catch (e: any) { status(e.name === "NotAllowedError" ? "Clipboard blocked. Use Upload file." : e.message); }
  });
  document.addEventListener("paste", event => {
    if (!target() || (document.getElementById("new-dialog") as HTMLDialogElement).open) return;
    const node = event.target as HTMLElement;
    if (!node.closest("#terminal, #compose")) return;
    const files = Array.from(event.clipboardData?.files || []);
    if (!files.length) return; // Text paste remains native terminal/composer input.
    event.preventDefault(); event.stopImmediatePropagation();
    void upload(files);
  }, true);
  return update;
}
