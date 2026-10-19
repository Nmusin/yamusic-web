import { state } from "./state.js";
import { formatSecs, FALLBACK_COVER, toast } from "./util.js";
import { saveSession, savePosition } from "./session-memory.js";
import { startWave, fetchMoreWaveTracks, hideWaveEnded, showWaveEnded } from "./wave.js";
import { hookTrackUI, toggleLikeCurrent } from "./likes-core.js";
import { updateFullPlayerUI, updateFullProgress } from "./player-screen.js";
import { updateMediaSession } from "./media-session.js";
import {
  audio,
  waveBtn,
  waveCover,
  wavePlaceholder,
  waveTrackTitle,
  waveTrackArtist,
  waveNextPreview,
  waveNextTitle,
  wavePlayIcon,
  btnWavePlay,
  btnWavePlayPrev,
  btnDislike,
  miniCover,
  miniTitle,
  miniArtist,
  miniPlayBtn,
  miniPlayIcon,
  miniNextBtn,
  miniPrevBtn,
  miniLikeBtn,
  miniProgressBar,
  miniProgressFill,
  miniTime,
  fullPlayIcon,
  btnLikeWave,
} from "./dom.js";

// Initialize Quality settings
try {
  const savedQuality = localStorage.getItem("ym_quality");
  if (savedQuality) state.quality = savedQuality;
} catch (e) {}

if (typeof document !== "undefined") {
  const qualityRadio = document.querySelector(`input[name="quality"][value="${state.quality}"]`);
  if (qualityRadio) qualityRadio.checked = true;

  document.querySelectorAll('input[name="quality"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      state.quality = e.target.value;
      try { localStorage.setItem("ym_quality", state.quality); } catch (err) {}
      if (state.currentTrack && audio) {
        const curTime = audio.currentTime;
        playTrack(state.currentTrack, curTime);
      }
    });
  });
}

// --- Play tracking: report real listening time to Yandex (play-audio) ---
// playId regenerates per track start; playedSeconds accumulates real (non-seek) time
let playReport = { playId: null, playedSeconds: 0, lastPos: 0 };

export function startPlayReport() {
  playReport.playId = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : "pm-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  playReport.playedSeconds = 0;
  playReport.lastPos = 0;
}

export function accumulatePlayTime() {
  if (!audio) return;
  const now = audio.currentTime;
  const delta = now - playReport.lastPos;
  // calls tick ~4 Hz; a big positive jump is a seek — not listening time
  if (delta > 0 && delta < 1.5) playReport.playedSeconds += delta;
  playReport.lastPos = now;
}

export function sendPlayReport(finished) {
  if (!state.currentTrack || !playReport.playId) return;
  // Yandex counts a listen from 30 seconds of playback (even partial)
  if (!finished && playReport.playedSeconds < 30) { playReport.playId = null; return; }
  const payload = {
    trackId: String(state.currentTrack.id),
    albumId: state.currentTrack.albumId ? String(state.currentTrack.albumId) : "",
    playId: playReport.playId,
    from: "web-mod",
    playedSeconds: Math.max(1, Math.round(playReport.playedSeconds)),
    trackLengthSeconds: audio && audio.duration && isFinite(audio.duration)
      ? Math.round(audio.duration)
      : Math.round((state.currentTrack.durationMs || 0) / 1000),
    endPositionSeconds: Math.round(playReport.lastPos),
    finished: !!finished,
  };
  playReport.playId = null; // guard against double-send
  const url = `/api/play-audio${state.oauthToken ? `?token=${encodeURIComponent(state.oauthToken)}` : ""}`;
  const body = JSON.stringify(payload);
  try {
    if (state.oauthToken && typeof navigator !== "undefined" && navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: "application/json" }))) return;
  } catch (e) {}
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true })
    .catch((e) => console.warn("play-audio report failed:", e));
}

// Update Track Time Display (e.g. "1:23 / 3:45")
export function showTime() {
  if (!miniTime || !audio) return;
  miniTime.textContent = `${formatSecs(audio.currentTime)} / ${formatSecs(audio.duration)}`;
}

export async function sendRotorFeedback(type) {
  if (!state.radioSessionId || !state.currentTrack) return;
  try {
    await fetch(
      `/api/rotor/feedback${state.oauthToken ? `?token=${encodeURIComponent(state.oauthToken)}` : ""}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          station: "user:onyourwave",
          type,
          trackId: String(state.currentTrack.id),
          from: type === "radioStarted" ? "web-mod" : undefined,
        }),
      }
    );
  } catch (e) {
    console.warn("Rotor feedback failed:", e);
  }
}

export function playTrack(track, seekTo = 0) {
  if (!track || !audio) return;
  const isWaveTrack = !!state.radioSessionId;
  state.currentTrack = track;
  state.playedTrackIds.add(String(track.id));
  hideWaveEnded(); // новый трек отменяет состояние «Очередь закончилась»
  saveSession(seekTo || 0);

  // Stream URL
  let streamUrl = `/api/stream?id=${encodeURIComponent(track.id)}&quality=${state.quality}`;
  if (state.oauthToken) streamUrl += `&token=${encodeURIComponent(state.oauthToken)}`;

  // currentTime can only be set after metadata is loaded
  state.pendingSeek = seekTo || 0;
  audio.src = streamUrl;
  if (state.pendingSeek > 0) {
    audio.addEventListener("loadedmetadata", () => {
      try { audio.currentTime = state.pendingSeek; } catch (e) {}
    }, { once: true });
  }
  audio.play().catch((e) => console.log("Playback error:", e));

  updateTrackUI(track);
  updateMediaSession(track);
  updateNextPreview();

  // New play session for play-audio reporting
  startPlayReport();

  // Tell Yandex the track started so the Wave session stays alive
  if (isWaveTrack) sendRotorFeedback("trackStarted");

  // If running low on tracks in wave, proactively fetch more
  if (state.radioSessionId && state.queue.length - state.queueIndex <= 2) {
    fetchMoreWaveTracks();
  }
}

export function updateTrackUI(track) {
  if (!track) return;

  // Wave UI
  if (waveTrackTitle) waveTrackTitle.textContent = track.title;
  if (waveTrackArtist) waveTrackArtist.textContent = track.artists;
  if (track.coverUri) {
    if (waveCover) {
      waveCover.src = track.coverUri;
      waveCover.classList.remove("hidden");
    }
    if (wavePlaceholder) wavePlaceholder.classList.add("hidden");
  } else {
    if (waveCover) waveCover.classList.add("hidden");
    if (wavePlaceholder) wavePlaceholder.classList.remove("hidden");
  }

  // MiniPlayer UI
  if (miniTitle) miniTitle.textContent = track.title;
  if (miniArtist) miniArtist.textContent = track.artists;
  if (miniCover) miniCover.src = track.coverUri || FALLBACK_COVER;

  // Full player screen UI
  updateFullPlayerUI(track);

  // Highlight currently playing track in search/likes/playlist lists.
  // Сначала полный сброс: класс + иконка на ВСЕХ ранее подсвеченных элементах,
  // иначе у прошлого трека навсегда остаётся fa-pause.
  if (typeof document !== "undefined") {
    document.querySelectorAll(".track-item.playing").forEach((el) => {
      el.classList.remove("playing");
      const staleIcon = el.querySelector(".track-play-btn i");
      if (staleIcon) staleIcon.className = "fa-solid fa-play";
    });
    const activeItem = document.querySelector(`.track-item[data-track-id="${CSS.escape(String(track.id))}"]`);
    if (activeItem) {
      activeItem.classList.add("playing");
      const icon = activeItem.querySelector(".track-play-btn i");
      if (icon) icon.className = "fa-solid fa-pause";
    }
  }

  hookTrackUI(track);
}

export function updateNextPreview() {
  const nextTrack = state.queue[state.queueIndex + 1];
  if (nextTrack) {
    if (waveNextTitle) waveNextTitle.textContent = `${nextTrack.title} — ${nextTrack.artists}`;
    if (waveNextPreview) waveNextPreview.classList.remove("hidden");
  } else {
    if (waveNextPreview) waveNextPreview.classList.add("hidden");
  }
}

export function setPlayState(playing) {
  state.isPlaying = playing;
  if (playing) {
    if (waveBtn) waveBtn.classList.add("playing");
    if (wavePlayIcon) wavePlayIcon.className = "fa-solid fa-pause";
    if (miniPlayIcon) miniPlayIcon.className = "fa-solid fa-pause";
    if (fullPlayIcon) fullPlayIcon.className = "fa-solid fa-pause";
  } else {
    if (waveBtn) waveBtn.classList.remove("playing");
    if (wavePlayIcon) wavePlayIcon.className = "fa-solid fa-play";
    if (miniPlayIcon) miniPlayIcon.className = "fa-solid fa-play";
    if (fullPlayIcon) fullPlayIcon.className = "fa-solid fa-play";
  }
}

// Controls
export function togglePlayPause() {
  if (!state.currentTrack) {
    // Восстановленная сессия: первый тап play продолжает с сохранённой позиции
    if (state.queue.length > 0 && state.queue[state.queueIndex]) {
      const resumeFrom = state.savedPos;
      state.savedPos = 0;
      playTrack(state.queue[state.queueIndex], resumeFrom);
      return;
    }
    startWave();
    return;
  }
  if (!audio) return;
  if (audio.paused) {
    audio.play();
  } else {
    audio.pause();
  }
}

export function playPrev() {
  if (state.queueIndex > 0) {
    state.queueIndex--;
    playTrack(state.queue[state.queueIndex]);
    saveSession(0);
  } else if (audio && audio.currentTime > 3) {
    // Restart current track like real players do
    audio.currentTime = 0;
  }
}

export async function playNext() {
  // Report the finished/abandoned track before switching away from it
  sendPlayReport(!!(audio && audio.ended));
  if (state.radioSessionId && state.currentTrack) sendRotorFeedback("skip");
  if (state.queueIndex < state.queue.length - 1) {
    state.queueIndex++;
    playTrack(state.queue[state.queueIndex]);
    saveSession(0);
  } else {
    if (state.radioSessionId) {
      if (waveTrackTitle) waveTrackTitle.textContent = "Загрузка новых треков...";
      if (waveTrackArtist) waveTrackArtist.textContent = "Волна продолжается";
      await fetchMoreWaveTracks();
      if (state.queueIndex < state.queue.length - 1) {
        state.queueIndex++;
        playTrack(state.queue[state.queueIndex]);
        saveSession(0);
      } else {
        startWave();
      }
    } else {
      // Вне волны очередь честно закончилась — экран конца вместо автозапуска волны
      showWaveEnded();
    }
  }
}

export async function dislikeAndSkip() {
  if (state.radioSessionId && state.currentTrack) sendRotorFeedback("dislike");
  toast("Дизлайк учтён, перематываем");
  await playNext();
}

// Audio Element Events
if (audio) {
  audio.addEventListener("play", () => { state.consecutiveErrors = 0; setPlayState(true); });
  audio.addEventListener("pause", () => setPlayState(false));
  audio.addEventListener("loadedmetadata", () => showTime());
  audio.addEventListener("timeupdate", () => {
    accumulatePlayTime();
    savePosition();
    if (audio.duration) {
      const percent = (audio.currentTime / audio.duration) * 100;
      if (miniProgressFill) miniProgressFill.style.width = percent + "%";
      updateFullProgress();
      showTime();
    }
  });
  // Auto-skip broken streams, but never loop endlessly on a broken connection
  audio.addEventListener("error", () => {
    if (!state.currentTrack) return;
    state.consecutiveErrors++;
    if (state.consecutiveErrors >= 5) {
      toast("Ошибка воспроизведения, остановлено");
      audio.pause();
      state.consecutiveErrors = 0;
      return;
    }
    toast("Трек недоступен, пропускаем...");
    setTimeout(playNext, 600);
  });
  audio.addEventListener("ended", () => {
    playNext();
  });
}

// Control listeners
if (btnWavePlay) btnWavePlay.addEventListener("click", togglePlayPause);
if (waveBtn) waveBtn.addEventListener("click", togglePlayPause);
if (miniPlayBtn) miniPlayBtn.addEventListener("click", togglePlayPause);
if (btnWavePlayPrev) btnWavePlayPrev.addEventListener("click", playPrev);
if (miniPrevBtn) miniPrevBtn.addEventListener("click", playPrev);
if (miniNextBtn) miniNextBtn.addEventListener("click", playNext);
if (miniLikeBtn) miniLikeBtn.addEventListener("click", toggleLikeCurrent);
if (btnLikeWave) btnLikeWave.addEventListener("click", toggleLikeCurrent);
if (btnDislike) btnDislike.addEventListener("click", dislikeAndSkip);

if (miniProgressBar) {
  miniProgressBar.addEventListener("click", (e) => {
    if (!audio || !audio.duration) return;
    const rect = miniProgressBar.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percent = clickX / rect.width;
    audio.currentTime = percent * audio.duration;
  });
}
