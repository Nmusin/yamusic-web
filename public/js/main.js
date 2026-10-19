// Main entry point for frontend ES modules
import "./state.js";
import "./dom.js";
import "./util.js";
import "./api.js";
import "./session-memory.js";
import "./audio-engine.js";
import "./wave.js";
import "./likes-core.js";
import "./tracks-lists.js";
import "./track-sheet.js";
import "./player-screen.js";
import "./media-session.js";
import "./nav.js";
import "./auth.js";
import "./pwa.js";

import { state } from "./state.js";
import { toast } from "./util.js";
import { audio, qualityTestBtn, qualityTestResult } from "./dom.js";
import { initAuth } from "./auth.js";

// ===== Sleep Timer =====
let sleepTimer = null;
let sleepTimerActive = false;

function updateSleepStatus() {
  const el = document.getElementById("sleepStatus");
  if (!el) return;
  if (sleepTimerActive && sleepTimer) {
    const left = Math.max(0, Math.ceil((sleepTimer.expiresAt - Date.now()) / 60000));
    el.textContent = `Музыка остановится через ~${left} мин`;
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

if (typeof document !== "undefined") {
  document.querySelectorAll(".sleep-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const minutes = parseInt(btn.getAttribute("data-sleep"), 10);
      if (sleepTimer) { clearTimeout(sleepTimer.t); sleepTimer = null; }
      sleepTimerActive = false;
      if (!minutes) {
        updateSleepStatus();
        toast("Таймер сна отключен");
        return;
      }
      const expiry = Date.now() + minutes * 60000;
      sleepTimer = {
        expiresAt: expiry,
        t: setTimeout(() => {
          sleepTimerActive = false;
          if (audio) audio.pause();
          updateSleepStatus();
          toast("Таймер сна: музыка остановлена 🌙");
        }, minutes * 60000),
      };
      sleepTimerActive = true;
      updateSleepStatus();
      toast(`Сон через ${minutes} мин`);
    });
  });
  setInterval(updateSleepStatus, 60000);
}

// --- Quality Test ---
if (qualityTestBtn) {
  qualityTestBtn.addEventListener("click", async () => {
    qualityTestBtn.disabled = true;
    if (qualityTestResult) {
      qualityTestResult.classList.remove("hidden");
      qualityTestResult.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Замеряем битрейт...';
    }
    try {
      const params = new URLSearchParams();
      if (state.oauthToken) params.set("token", state.oauthToken);
      if (state.currentTrack) {
        params.set("id", state.currentTrack.id);
        if (state.currentTrack.durationMs) params.set("durationMs", state.currentTrack.durationMs);
      }
      const res = await fetch(`/api/quality-test?${params.toString()}`);
      const data = await res.json();

      if (data.error) {
        if (qualityTestResult) qualityTestResult.innerHTML = `<div class="qt-error">${data.error}</div>`;
      } else {
        const rows = (data.results || [])
          .map((r) => {
            if (r.error) {
              return `<div class="qt-row"><div class="qt-q">${r.quality}</div><div class="qt-val qt-bad">✗ ${r.error}</div></div>`;
            }
            const kb = r.kbps ? `${r.kbps} kbps` : "—";
            const mb = r.sizeMb ? `${r.sizeMb} МБ` : "";
            const bad = r.preview ? "qt-bad" : (r.kbps && r.kbps < 100 ? "qt-bad" : "qt-good");
            return `<div class="qt-row">
              <div class="qt-q">${r.quality} <small>${r.codec || ""}</small></div>
              <div class="qt-val ${bad}">${kb} ${mb} ${r.preview ? "ПРЕВЬЮ!" : ""}</div>
            </div>`;
          })
          .join("");
        if (qualityTestResult) {
          qualityTestResult.innerHTML = `<div class="qt-title">Трек ${data.track}, длительность ${Math.round(data.durationMs / 1000)} c:</div>${rows}`;
        }
      }
    } catch (e) {
      if (qualityTestResult) qualityTestResult.innerHTML = `<div class="qt-error">${e.message}</div>`;
    } finally {
      qualityTestBtn.disabled = false;
    }
  });
}

// Bootstrap application
initAuth();
