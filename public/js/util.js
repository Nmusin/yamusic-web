export function formatSecs(t) {
  if (!isFinite(t)) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatDuration(ms) {
  if (!ms) return "";
  return `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
}

export const FALLBACK_COVER = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#2a2a2a"/><text x="24" y="30" font-size="20" text-anchor="middle" fill="#555">♪</text></svg>'
);

let toastTimer = null;
export function toast(msg) {
  if (typeof document === "undefined") return;
  if (!toastTimer) {
    const el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
    toastTimer = el;
  }
  toastTimer.textContent = msg;
  toastTimer.classList.add("visible");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    if (toastTimer) toastTimer.classList.remove("visible");
  }, 2500);
}
