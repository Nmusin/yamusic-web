import { state } from "./state.js";
import { formatSecs, FALLBACK_COVER } from "./util.js";
import { msCoverUrl, updatePositionState, stopPlayback } from "./media-session.js";
import { trackIdLiked, likeTrack } from "./likes-core.js";
import { playPrev, playNext, togglePlayPause } from "./audio-engine.js";
import {
  playerScreen,
  fullCloseBtn,
  fullCover,
  fullTitle,
  fullArtist,
  fullLikeBtn,
  fullLikeIcon,
  fullTimeElapsed,
  fullTimeTotal,
  fullProgress,
  fullProgressFill,
  fullProgressKnob,
  fullPrevBtn,
  fullBack10Btn,
  fullFwd10Btn,
  fullNextBtn,
  fullPlayBtn,
  fullStopBtn,
  audio,
} from "./dom.js";

// ---------- Full Player Screen ----------
export function isPlayerOpen() {
  return playerScreen && !playerScreen.classList.contains("hidden");
}

export function openPlayer() {
  if (state.currentTrack) updateFullPlayerUI(state.currentTrack);
  updateFullProgress();
  if (playerScreen) playerScreen.classList.remove("hidden");
}

export function closePlayer() {
  if (playerScreen) playerScreen.classList.add("hidden");
}

export function updateFullPlayerUI(track) {
  if (!track) return;
  if (fullTitle) fullTitle.textContent = track.title;
  if (fullArtist) fullArtist.textContent = track.artists;
  if (fullCover) {
    fullCover.onerror = () => { fullCover.onerror = null; fullCover.src = FALLBACK_COVER; };
    fullCover.src = msCoverUrl(track, "600x600");
  }
  const liked = trackIdLiked(track);
  if (fullLikeIcon) fullLikeIcon.className = liked ? "fa-solid fa-heart" : "fa-regular fa-heart";
  if (fullLikeBtn) fullLikeBtn.classList.toggle("liked", liked);
  if (fullTimeTotal) {
    fullTimeTotal.textContent = formatSecs(track.durationMs ? track.durationMs / 1000 : (audio && audio.duration ? audio.duration : 0));
  }
}

export function updateFullProgress() {
  if (!audio || !audio.duration) {
    if (fullProgressFill) fullProgressFill.style.width = "0%";
    if (fullProgressKnob) fullProgressKnob.style.left = "0%";
    if (fullTimeElapsed) fullTimeElapsed.textContent = "0:00";
    return;
  }
  const percent = Math.min(audio.currentTime / audio.duration, 1) * 100;
  if (fullProgressFill) fullProgressFill.style.width = percent + "%";
  if (fullProgressKnob) fullProgressKnob.style.left = percent + "%";
  if (fullTimeElapsed) fullTimeElapsed.textContent = formatSecs(audio.currentTime);
}

// Перемотка: drag-полоса (pointer events + setPointerCapture).
let scrubbing = false;

function clientXToSeconds(clientX) {
  if (!fullProgress || !audio) return 0;
  const rect = fullProgress.getBoundingClientRect();
  const p = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
  return p * (audio.duration || 0);
}

function scrubToClientX(clientX) {
  if (!audio || !audio.duration) return;
  const seconds = clientXToSeconds(clientX);
  const percent = Math.min(seconds / audio.duration, 1) * 100;
  if (fullProgressFill) fullProgressFill.style.width = percent + "%";
  if (fullProgressKnob) fullProgressKnob.style.left = percent + "%";
  if (fullTimeElapsed) fullTimeElapsed.textContent = formatSecs(seconds);
}

if (fullProgress) {
  fullProgress.addEventListener("pointerdown", (e) => {
    if (!audio || !audio.duration) return;
    scrubbing = true;
    fullProgress.setPointerCapture(e.pointerId);
    scrubToClientX(e.clientX);
  });
  fullProgress.addEventListener("pointermove", (e) => {
    if (!scrubbing) return;
    scrubToClientX(e.clientX);
  });
  fullProgress.addEventListener("pointerup", (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    if (audio && audio.duration) {
      audio.currentTime = clientXToSeconds(e.clientX);
      updatePositionState();
    }
  });
  fullProgress.addEventListener("pointercancel", () => {
    scrubbing = false;
    updateFullProgress();
  });
}

// Крупный ряд управления
if (fullPrevBtn) fullPrevBtn.addEventListener("click", playPrev);
if (fullNextBtn) fullNextBtn.addEventListener("click", playNext);
if (fullPlayBtn) fullPlayBtn.addEventListener("click", togglePlayPause);
if (fullBack10Btn) fullBack10Btn.addEventListener("click", () => {
  if (audio && audio.duration) {
    audio.currentTime = Math.max(audio.currentTime - 10, 0);
    updatePositionState();
  }
});
if (fullFwd10Btn) fullFwd10Btn.addEventListener("click", () => {
  if (audio && audio.duration) {
    audio.currentTime = Math.min(audio.currentTime + 10, audio.duration);
    updatePositionState();
  }
});
if (fullStopBtn) fullStopBtn.addEventListener("click", stopPlayback);
if (fullCloseBtn) fullCloseBtn.addEventListener("click", closePlayer);
if (fullLikeBtn) fullLikeBtn.addEventListener("click", () => likeTrack(state.currentTrack));
