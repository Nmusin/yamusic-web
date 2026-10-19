import { audio } from "./dom.js";
import { FALLBACK_COVER } from "./util.js";
import { playNext, playPrev } from "./audio-engine.js";

// Android Lockscreen & Headset controls via MediaSession API
export function msCoverUrl(track, size) {
  if (!track || !track.coverUri) return "";
  return track.coverUri.replace(/(\d+)x(\d+)/, size);
}

export function updatePositionState() {
  if (typeof navigator !== "undefined" && "mediaSession" in navigator && "setPositionState" in navigator.mediaSession) {
    if (!audio || !audio.duration || !isFinite(audio.duration) || isNaN(audio.duration)) return;
    try {
      const pos = Math.min(Math.max(audio.currentTime || 0, 0), audio.duration);
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate || 1.0,
        position: pos,
      });
    } catch (e) {}
  }
}

// Зарегистрировать обработчики действий MediaSession
export function initMediaSession() {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;

  const actions = [
    ["play", () => { if (audio) audio.play().catch(() => {}); }],
    ["pause", () => { if (audio) audio.pause(); }],
    ["stop", () => stopPlayback()],
    ["nexttrack", () => playNext()],
    ["previoustrack", () => playPrev()],
    ["seekbackward", (details) => {
      const skip = (details && details.seekOffset) || 10;
      if (audio && audio.duration && isFinite(audio.duration)) {
        audio.currentTime = Math.max(audio.currentTime - skip, 0);
        updatePositionState();
      }
    }],
    ["seekforward", (details) => {
      const skip = (details && details.seekOffset) || 10;
      if (audio && audio.duration && isFinite(audio.duration)) {
        audio.currentTime = Math.min(audio.currentTime + skip, audio.duration);
        updatePositionState();
      }
    }],
    ["seekto", (details) => {
      if (!audio || details.seekTime == null) return;
      if (details.fastSeek && "fastSeek" in audio) {
        audio.fastSeek(details.seekTime);
      } else {
        audio.currentTime = details.seekTime;
      }
      updatePositionState();
    }],
  ];

  for (const [action, handler] of actions) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch (e) {}
  }
}

export function updateMediaSession(track) {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator) || !track) return;

  try {
    const artwork = [];
    if (track.coverUri) {
      const u200 = msCoverUrl(track, "200x200");
      const u600 = msCoverUrl(track, "600x600");
      if (u200 && u200.startsWith("http")) {
        artwork.push({ src: u200, sizes: "200x200", type: "image/jpeg" });
      }
      if (u600 && u600.startsWith("http")) {
        artwork.push({ src: u600, sizes: "600x600", type: "image/jpeg" });
      }
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || "Трек",
      artist: track.artists || "Яндекс Музыка",
      album: track.album || "Яндекс Музыка",
      artwork,
    });
  } catch (e) {
    console.warn("MediaMetadata init error:", e);
  }

  initMediaSession();
  updatePositionState();
}

// Останов: пауза + откат позиции; состояние иконок — через события audio.
export function stopPlayback() {
  if (!audio) return;
  audio.pause();
  audio.currentTime = 0;
  updatePositionState();
}

// Инициализация обработчиков сразу при загрузке модуля
initMediaSession();

// Синхронизация playbackState уведомления с событиями самого <audio>.
if (audio) {
  audio.addEventListener("play", () => {
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      try { navigator.mediaSession.playbackState = "playing"; } catch (e) {}
    }
  });
  audio.addEventListener("pause", () => {
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      try { navigator.mediaSession.playbackState = "paused"; } catch (e) {}
    }
  });
  audio.addEventListener("loadedmetadata", () => updatePositionState());
  audio.addEventListener("seeked", () => updatePositionState());
  audio.addEventListener("timeupdate", () => updatePositionState());
}
