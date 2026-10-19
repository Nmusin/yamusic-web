import { audio } from "./dom.js";
import { FALLBACK_COVER } from "./util.js";
import { playNext, playPrev } from "./audio-engine.js";

// Client-side diagnostic logger
export function logClient(cat, data) {
  try {
    const payload = {
      cat,
      data,
      time: new Date().toISOString(),
    };
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      navigator.sendBeacon("/api/client-log", new Blob([JSON.stringify(payload)], { type: "application/json" }));
    } else {
      fetch("/api/client-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {});
    }
  } catch (e) {}
}

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
    } catch (e) {
      logClient("position_state_error", { err: e.message, dur: audio && audio.duration, pos: audio && audio.currentTime });
    }
  }
}

// Зарегистрировать обработчики действий MediaSession
export function initMediaSession() {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    logClient("mediasession_unavailable", {
      hasNavigator: typeof navigator !== "undefined",
      hasMediaSession: typeof navigator !== "undefined" && "mediaSession" in navigator,
      isSecureContext: typeof window !== "undefined" ? window.isSecureContext : null,
      protocol: typeof location !== "undefined" ? location.protocol : null,
      ua: typeof navigator !== "undefined" ? navigator.userAgent : null,
    });
    return;
  }

  const actionResults = {};
  const actions = [
    ["play", () => { logClient("action_play", {}); if (audio) audio.play().catch(() => {}); }],
    ["pause", () => { logClient("action_pause", {}); if (audio) audio.pause(); }],
    ["stop", () => { logClient("action_stop", {}); stopPlayback(); }],
    ["nexttrack", () => { logClient("action_next", {}); playNext(); }],
    ["previoustrack", () => { logClient("action_prev", {}); playPrev(); }],
    ["seekbackward", (details) => {
      const skip = (details && details.seekOffset) || 10;
      logClient("action_seekbackward", { skip });
      if (audio && audio.duration && isFinite(audio.duration)) {
        audio.currentTime = Math.max(audio.currentTime - skip, 0);
        updatePositionState();
      }
    }],
    ["seekforward", (details) => {
      const skip = (details && details.seekOffset) || 10;
      logClient("action_seekforward", { skip });
      if (audio && audio.duration && isFinite(audio.duration)) {
        audio.currentTime = Math.min(audio.currentTime + skip, audio.duration);
        updatePositionState();
      }
    }],
    ["seekto", (details) => {
      logClient("action_seekto", { details });
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
      actionResults[action] = "ok";
    } catch (e) {
      actionResults[action] = e.message;
    }
  }

  logClient("mediasession_init", {
    isSecureContext: typeof window !== "undefined" ? window.isSecureContext : null,
    protocol: typeof location !== "undefined" ? location.protocol : null,
    actionResults,
    ua: typeof navigator !== "undefined" ? navigator.userAgent : null,
    notificationPermission: typeof Notification !== "undefined" ? Notification.permission : "no_Notification_api",
  });
}

export function updateMediaSession(track) {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator) || !track) {
    logClient("update_skip", { reason: "no_navigator_or_track" });
    return;
  }

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
    logClient("metadata_set", { title: track.title, artists: track.artists, artworkCount: artwork.length });
  } catch (e) {
    logClient("metadata_error", { err: e.message });
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
    logClient("audio_play", { currentTime: audio.currentTime, duration: audio.duration });
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      try {
        navigator.mediaSession.playbackState = "playing";
        logClient("playback_state_set", { state: "playing" });
      } catch (e) {
        logClient("playback_state_error", { err: e.message });
      }
    }
  });
  audio.addEventListener("pause", () => {
    logClient("audio_pause", { currentTime: audio.currentTime });
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      try {
        navigator.mediaSession.playbackState = "paused";
        logClient("playback_state_set", { state: "paused" });
      } catch (e) {
        logClient("playback_state_error", { err: e.message });
      }
    }
  });
  audio.addEventListener("loadedmetadata", () => {
    logClient("audio_loadedmetadata", { duration: audio.duration });
    updatePositionState();
  });
  audio.addEventListener("seeked", () => updatePositionState());
  audio.addEventListener("timeupdate", () => updatePositionState());
}

if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => {
    logClient("window_error", { msg: e.message, src: e.filename, lineno: e.lineno, col: e.colno });
  });
  window.addEventListener("unhandledrejection", (e) => {
    logClient("unhandled_rejection", { reason: String(e.reason) });
  });
}
