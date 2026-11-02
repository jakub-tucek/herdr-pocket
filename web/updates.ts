declare const __BUILD_ID__: string;

export function watchUpdates(beforeReload: () => void) {
  const banner = document.getElementById("update-banner")!;
  let checking = false, dismissed = "", available = "";
  async function check() {
    if (checking || document.hidden) return;
    checking = true;
    try {
      const response = await fetch("/version.json", { cache: "no-store", signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      const value = await response.json();
      if (typeof value.version !== "string" || !/^[a-f0-9]{16}$/.test(value.version)) return;
      available = value.version;
      banner.hidden = available === __BUILD_ID__ || available === dismissed;
    } catch { /* Offline and deploy-in-progress checks must not interrupt a terminal. */ }
    finally { checking = false; }
  }
  document.getElementById("update-refresh")!.addEventListener("click", () => {
    try { beforeReload(); }
    catch { if (!confirm("This browser could not save your view and draft. Refresh anyway?")) return; }
    location.reload();
  });
  document.getElementById("update-later")!.addEventListener("click", () => { dismissed = available; banner.hidden = true; });
  window.addEventListener("focus", () => void check());
  window.addEventListener("online", () => void check());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void check(); });
  setInterval(() => void check(), 60_000);
  void check();
}
