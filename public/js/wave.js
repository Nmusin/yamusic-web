import { state } from "./state.js";
import { waveTrackTitle, waveTrackArtist, waveEnded, waveEndedBtn } from "./dom.js";
import { playTrack, updateNextPreview } from "./audio-engine.js";

// "Моя Волна" Continuous Fetch (NO LOOPS / REPEATS)
export async function startWave() {
  hideWaveEnded();
  if (waveTrackTitle) waveTrackTitle.textContent = "Запуск Волны...";
  if (waveTrackArtist) waveTrackArtist.textContent = "Подбираем треки...";
  state.radioSessionId = null;
  state.queue = [];
  state.queueIndex = 0;

  let waveUrl = "/api/wave";
  if (state.oauthToken) waveUrl += `?token=${encodeURIComponent(state.oauthToken)}`;

  try {
    const resp = await fetch(waveUrl);
    const data = await resp.json();
    if (data.tracks && data.tracks.length > 0) {
      state.radioSessionId = data.radioSessionId || null;
      const freshTracks = data.tracks.filter((t) => !state.playedTrackIds.has(String(t.id)));
      state.queue = freshTracks.length > 0 ? freshTracks : data.tracks;
      state.queueIndex = 0;
      // Inform the rotor that a new radio session has begun
      if (state.radioSessionId) {
        try {
          await fetch(
            `/api/rotor/feedback${state.oauthToken ? `?token=${encodeURIComponent(state.oauthToken)}` : ""}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ station: "user:onyourwave", type: "radioStarted", from: "web-mod" }),
            }
          );
        } catch (e) {}
      }
      // playTrack() itself sends "trackStarted" because radioSessionId is set
      playTrack(state.queue[0]);
    } else {
      if (waveTrackTitle) waveTrackTitle.textContent = "Ошибка загрузки";
      if (waveTrackArtist) waveTrackArtist.textContent = "Попробуйте еще раз";
    }
  } catch (e) {
    if (waveTrackTitle) waveTrackTitle.textContent = "Ошибка сети";
    if (waveTrackArtist) waveTrackArtist.textContent = e.message;
  }
}

export async function fetchMoreWaveTracks() {
  if (state.isFetchingMore || !state.radioSessionId) return;
  state.isFetchingMore = true;

  try {
    let nextUrl = `/api/wave?sessionId=${encodeURIComponent(state.radioSessionId)}`;
    if (state.oauthToken) nextUrl += `&token=${encodeURIComponent(state.oauthToken)}`;

    const resp = await fetch(nextUrl);
    const data = await resp.json();
    if (data.tracks && data.tracks.length > 0) {
      if (data.radioSessionId) state.radioSessionId = data.radioSessionId;

      const newTracks = data.tracks.filter((t) => !state.playedTrackIds.has(String(t.id)));
      if (newTracks.length > 0) {
        state.queue.push(...newTracks);
      } else {
        state.queue.push(...data.tracks);
      }
      updateNextPreview();
    }
  } catch (e) {
    console.error("Error fetching more wave tracks:", e);
  } finally {
    state.isFetchingMore = false;
  }
}

// ===== Конец очереди (вне волны) =====
export function showWaveEnded() {
  if (waveTrackTitle) waveTrackTitle.textContent = "Очередь закончилась";
  if (waveTrackArtist) waveTrackArtist.textContent = "Волна не запущена";
  if (waveEnded) waveEnded.classList.remove("hidden");
}

export function hideWaveEnded() {
  if (waveEnded) waveEnded.classList.add("hidden");
}

if (waveEndedBtn) {
  waveEndedBtn.addEventListener("click", () => {
    hideWaveEnded();
    startWave();
  });
}
