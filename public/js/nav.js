import { togglePlayPause } from "./audio-engine.js";
import { loadLikes, loadPlaylists, loadSmart } from "./tracks-lists.js";
import { loginModal } from "./dom.js";

// Tab Navigation
export function switchTab(tabId) {
  if (typeof document === "undefined") return;
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-tab") === tabId);
  });
  document.querySelectorAll(".tab-content").forEach((c) => {
    c.classList.toggle("active", c.id === tabId);
  });
}

if (typeof document !== "undefined") {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.getAttribute("data-tab");
      switchTab(tabId);
      // Load likes/playlists lazily on first open
      if (tabId === "tab-likes") loadLikes();
      if (tabId === "tab-playlists") loadPlaylists();
      if (tabId === "tab-smart") loadSmart();
    });
  });

  // Spacebar play/pause (except when typing in inputs)
  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || (loginModal && loginModal.classList.contains("hidden") === false)) return;
    if (e.code === "Space") {
      e.preventDefault();
      togglePlayPause();
    }
  });
}
