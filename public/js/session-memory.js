import { state } from "./state.js";
import { audio, miniProgressFill, miniTime, waveTrackArtist } from "./dom.js";
import { updateTrackUI, setPlayState } from "./audio-engine.js";

// --- Token persistence: localStorage (Android/desktop Chrome) ---
export function getToken() {
  try { return localStorage.getItem("ym_token") || ""; } catch (e) { return ""; }
}

export function saveToken(token) {
  try { localStorage.setItem("ym_token", token); } catch (e) {}
}

export function clearToken() {
  try { localStorage.removeItem("ym_token"); } catch (e) {}
  try { localStorage.removeItem("ym_user"); } catch (e) {}
}

export function saveUser(user) {
  try { localStorage.setItem("ym_user", JSON.stringify(user)); } catch (e) {}
}

// Module-level initialization
state.oauthToken = getToken();
try {
  state.cachedUserStr = localStorage.getItem("ym_user");
} catch (e) {
  state.cachedUserStr = null;
}

// --- Session memory: очередь + позиция по ключу токена (ym_session:<hash>) ---
// Ключ пересчитывается при каждом использовании: oauthToken меняется в
// onLoginSuccess/clearToken, старый ключ нельзя кешировать глобально.
export async function tokenKey() {
  const tok = getToken();
  if (tok && typeof crypto !== "undefined" && crypto.subtle) {
    try {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tok));
      const hex = Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      return "ym_session:" + hex.slice(0, 12);
    } catch (e) {}
  }
  // http-контекст: crypto.subtle недоступен — сам строковый токен до 20 симв.
  return "ym_session:" + (tok ? tok.slice(0, 20) : "guest");
}

export function sessionSource() {
  return state.radioSessionId ? "Моя Волна" : "Очередь";
}

// _posOverride: позиция момента проигрывания нового трека (иначе audio.currentTime)
export async function saveSession(posOverride) {
  if (!state.queue.length || !state.currentTrack) return;
  try {
    // Хвост очереди (текущий + следующие), не длиннее 100 треков
    let sliceStart = 0;
    if (state.queue.length > 100) sliceStart = Math.max(0, state.queueIndex - 99);
    const kept = state.queue.slice(sliceStart).map((t) => ({
      id: t.id,
      title: t.title,
      artists: t.artists,
      album: t.album || "",
      albumId: t.albumId || "",
      coverUri: t.coverUri || "",
      durationMs: Number(t.durationMs) || 0,
    }));
    const savedIndex = state.queueIndex - sliceStart;
    const pos = posOverride !== undefined ? Number(posOverride) || 0 : Math.round((audio && audio.currentTime) || state.savedPos || 0);
    const payload = {
      v: 1,
      queue: kept,
      queueIndex: savedIndex,
      radioSessionId: state.radioSessionId,
      source: sessionSource(),
      playedTrackIds: Array.from(state.playedTrackIds).slice(-200),
      pos: pos,
      trackId: String(state.currentTrack.id),
      token: (getToken() || "").slice(0, 12),
    };
    localStorage.setItem(await tokenKey(), JSON.stringify(payload));
  } catch (e) {
    console.warn("saveSession failed:", e);
  }
}

export function savePosition() {
  if (!state.currentTrack || !(audio && audio.currentTime)) return;
  const now = Date.now();
  if (now - state.lastPosSave < 5000) return;
  state.lastPosSave = now;
  saveSession();
}

// Молчаливое восстановление при загрузке: очередь + мини-плеер в паузе.
// НЕ автостарт: первый playAudio-тап добирает сохранённую позицию из savedPos.
export async function restoreSession() {
  try {
    const raw = localStorage.getItem(await tokenKey());
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || data.v !== 1 || !Array.isArray(data.queue) || data.queue.length === 0) return;
    const idx = Math.min(Math.max(0, data.queueIndex || 0), data.queue.length - 1);
    state.queue = data.queue;
    state.queueIndex = idx;
    state.radioSessionId = data.radioSessionId || null;
    state.playedTrackIds = new Set(Array.isArray(data.playedTrackIds) ? data.playedTrackIds.slice(-200) : []);
    state.savedPos = Math.max(0, Number(data.pos) || 0);
    const track = state.queue[state.queueIndex];
    if (!track) return;

    // Мини-плеер/волна: трек, пауза, прогресс на сохранённой позиции
    updateTrackUI(track);
    setPlayState(false);
    const durSec = (track.durationMs || 0) / 1000;
    if (state.savedPos && durSec) {
      const fmt = (t) => {
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        return `${m}:${String(s).padStart(2, "0")}`;
      };
      if (miniProgressFill) miniProgressFill.style.width = Math.min(100, (state.savedPos / durSec) * 100) + "%";
      if (miniTime) miniTime.textContent = `${fmt(state.savedPos)} / ${fmt(durSec)}`;
    }
    // Подпись источника на экране волны; waveTrackTitle остаётся от трека
    if (waveTrackArtist) waveTrackArtist.textContent = "Продолжаем: " + (data.source || sessionSource());
  } catch (e) {
    console.warn("restoreSession failed:", e);
  }
}
