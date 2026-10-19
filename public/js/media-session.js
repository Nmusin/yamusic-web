import { audio } from "./dom.js";
import { FALLBACK_COVER } from "./util.js";
import { playNext, playPrev } from "./audio-engine.js";

// Android Lockscreen & Headset controls via MediaSession API
// Референс: googlechrome.github.io/samples/media-session/audio.html + MDN setPositionState.
export function msCoverUrl(track, size) {
  // Сервер отдаёт уже подставленный размер (200x200/400x400). Для обложки
  // плеера/уведомления поднимаем до size, если шаблон не подставлен раньше.
  if (!track || !track.coverUri) return FALLBACK_COVER;
  return track.coverUri.replace(/(\d+)x(\d+)/, size);
}

export function updatePositionState() {
  if (typeof navigator !== "undefined" && "mediaSession" in navigator && "setPositionState" in navigator.mediaSession) {
    if (!audio || !audio.duration) return; // MDN: duration обязателен, иначе TypeError
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate,
        position: Math.min(audio.currentTime, audio.duration),
      });
    } catch (e) {}
  }
}

export function updateMediaSession(track) {
  if (typeof navigator !== "undefined" && "mediaSession" in navigator && track) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artists,
      album: track.album || "Яндекс Музыка",
      artwork: track.coverUri ? [
        { src: msCoverUrl(track, "200x200"), sizes: "200x200", type: "image/jpeg" },
        { src: msCoverUrl(track, "600x600"), sizes: "600x600", type: "image/jpeg" },
      ] : [],
    });

    // Важно: setActionHandler для каждого действия отдельным try/catch —
    // одно неподдерживаемое действие не должно глушить остальные.
    const actions = {
      play: () => { if (audio) audio.play().catch(() => {}); },
      pause: () => { if (audio) audio.pause(); },
      stop: () => stopPlayback(),
      nexttrack: () => playNext(),
      previoustrack: () => playPrev(),
      seekbackward: (details) => {
        const skip = details.seekOffset || 10;
        if (audio && audio.duration) {
          audio.currentTime = Math.max(audio.currentTime - skip, 0);
          updatePositionState();
        }
      },
      seekforward: (details) => {
        const skip = details.seekOffset || 10;
        if (audio && audio.duration) {
          audio.currentTime = Math.min(audio.currentTime + skip, audio.duration);
          updatePositionState();
        }
      },
      seekto: (details) => {
        if (!audio || details.seekTime == null) return;
        if (details.fastSeek && "fastSeek" in audio) {
          audio.fastSeek(details.seekTime);
        } else {
          audio.currentTime = details.seekTime;
        }
        updatePositionState();
      },
    };
    for (const [action, handler] of Object.entries(actions)) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch (e) {}
    }
  }
}

// Останов: пауза + откат позиции; состояние иконок — через события audio.
export function stopPlayback() {
  if (!audio) return;
  audio.pause();
  audio.currentTime = 0;
  updatePositionState();
}

// Синхронизация playbackState уведомления с событиями самого <audio>.
if (audio) {
  audio.addEventListener("play", () => {
    if (typeof navigator !== "undefined" && "mediaSession" in navigator && "playbackState" in navigator.mediaSession) {
      navigator.mediaSession.playbackState = "playing";
    }
  });
  audio.addEventListener("pause", () => {
    if (typeof navigator !== "undefined" && "mediaSession" in navigator && "playbackState" in navigator.mediaSession) {
      navigator.mediaSession.playbackState = "paused";
    }
  });
  audio.addEventListener("loadedmetadata", () => updatePositionState());
  audio.addEventListener("seeked", () => updatePositionState());
}
