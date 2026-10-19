import { state } from "./state.js";
import { formatDuration, FALLBACK_COVER, toast } from "./util.js";
import { trackIdLiked, likeTrack } from "./likes-core.js";
import { playTrack } from "./audio-engine.js";
import { openPlayer } from "./player-screen.js";
import { saveSession } from "./session-memory.js";
import {
  trackSheet,
  sheetBackdrop,
  sheetCover,
  sheetTitle,
  sheetSub,
  sheetLikeBtn,
  sheetLikeIcon,
  sheetNextBtn,
  sheetPlayBtn,
  sheetCloseBtn,
  miniDetails,
  miniCover,
} from "./dom.js";

// Suppress the click that always follows a long-press. Flag + capture-phase
// once-listener on the list container: the capture stop happens before the
// item's bubble handler can start playback.
export let sheetClickSuppressUntil = 0;
// container -> drain-listener: максимум один живой подавитель на контейнер,
// иначе once-анонимные листенеры накапливаются на постоянных контейнерах.
const sheetClickDrains = new Map();

export function suppressNextClick(container) {
  if (!container) return;
  sheetClickSuppressUntil = Date.now() + 800;
  // Хвост прошлого подавления на этом же контейнере снимаем до установки нового
  const prev = sheetClickDrains.get(container);
  if (prev) {
    container.removeEventListener("click", prev, { capture: true });
    sheetClickDrains.delete(container);
  }
  const drain = (e) => {
    container.removeEventListener("click", drain, { capture: true });
    sheetClickDrains.delete(container);
    if (Date.now() < sheetClickSuppressUntil) {
      sheetClickSuppressUntil = 0;
      e.stopPropagation();
      e.preventDefault();
    }
  };
  sheetClickDrains.set(container, drain);
  container.addEventListener("click", drain, { capture: true });
  // Killswitch: листенер живёт не дольше 900 мс, даже если click не прилетел
  setTimeout(() => {
    container.removeEventListener("click", drain, { capture: true });
    if (sheetClickDrains.get(container) === drain) sheetClickDrains.delete(container);
  }, 900);
}

export function applySheetHeart(liked) {
  if (sheetLikeIcon) sheetLikeIcon.className = liked ? "fa-solid fa-heart" : "fa-regular fa-heart";
  if (sheetLikeBtn) sheetLikeBtn.classList.toggle("liked", liked);
}

// Сердце sheet-трека: локальное состояние (likedIds) мгновенно; если общий
// список лайков ещё не подгружен/краснеет после изменений (likesDirty) —
// точечная проверка батч-эндпоинтом /api/like-status, без ломающего refreshLikeState.
export async function refreshSheetLikeState() {
  if (!state.sheetTrack) return;
  const track = state.sheetTrack;
  applySheetHeart(trackIdLiked(track));
  if (!state.oauthToken || (state.likesLoaded && !state.likesDirty)) return;
  try {
    const res = await fetch(
      `/api/like-status?ids=${encodeURIComponent(String(track.id))}` +
      `&token=${encodeURIComponent(state.oauthToken)}`
    );
    const data = await res.json();
    const liked = (data.likedIds || []).includes(String(track.id));
    if (liked) state.likedIds.add(String(track.id));
    else state.likedIds.delete(String(track.id));
    if (state.sheetTrack === track) applySheetHeart(liked);
  } catch (e) {}
}

export function openTrackSheet(track) {
  if (!track) return;
  state.sheetTrack = track;
  if (sheetTitle) sheetTitle.textContent = track.title;
  // «артисты · альбом · mm:ss»
  if (sheetSub) {
    sheetSub.textContent = [track.artists, track.album, formatDuration(track.durationMs)]
      .filter(Boolean).join(" · ");
  }
  if (sheetCover) {
    sheetCover.onerror = () => { sheetCover.src = FALLBACK_COVER; };
    sheetCover.src = track.coverUri || FALLBACK_COVER;
  }
  state.sheetOpenedAt = Date.now();
  if (trackSheet) trackSheet.classList.remove("hidden");
  refreshSheetLikeState();
}

export function closeTrackSheet() {
  if (trackSheet) trackSheet.classList.add("hidden");
  state.sheetTrack = null;
  // Флаг подавления не должен переживать sheet: иначе первый легитимный тап
  // по треку заглохнет, если после лонг-пресса пользователь закрыл sheet
  // крестиком (click мимо контейнера списка, окно 800 мс оставалось живым).
  sheetClickSuppressUntil = 0;
}

// «Следом»: в волне очередь ведёт Яндекс — не вставляем
export function addTrackNext() {
  if (!state.sheetTrack) return;
  if (state.radioSessionId !== null) {
    toast("В волне очередь ведёт Яндекс");
    return;
  }
  state.queue.splice(state.queueIndex + 1, 0, state.sheetTrack);
  toast("Следом за текущим");
  saveSession(); // внутри игнорируется, если currentTrack нет
}

// «Слушать»: вне радио — очередь из одного трека, как из поиска
export function playTrackFromSheet() {
  if (!state.sheetTrack) return;
  state.radioSessionId = null;
  state.queue = [state.sheetTrack];
  state.queueIndex = 0;
  playTrack(state.sheetTrack); // прячет плашку конца очереди, сохраняет сессию
  closeTrackSheet();
}

// Клик по только что открывшемуся backdrop — это хвост касания от лонг-пресса,
// не попытка закрыть: игнорируем первые 500 мс.
export function closeTrackSheetFromBackdrop() {
  if (Date.now() - state.sheetOpenedAt < 500) return;
  closeTrackSheet();
}

if (sheetCloseBtn) sheetCloseBtn.addEventListener("click", closeTrackSheet);
if (sheetBackdrop) sheetBackdrop.addEventListener("click", closeTrackSheetFromBackdrop);
if (sheetLikeBtn) sheetLikeBtn.addEventListener("click", () => likeTrack(state.sheetTrack));
if (sheetNextBtn) sheetNextBtn.addEventListener("click", addTrackNext);
if (sheetPlayBtn) sheetPlayBtn.addEventListener("click", playTrackFromSheet);

// Мини-плеер: тап по инфо-зоне/обложке → полный экран плеера;
// лонг-пресс → карточка трека (как в списках: тап — крупное действие).
if (miniDetails) {
  miniDetails.addEventListener("click", () => {
    if (state.currentTrack) openPlayer();
  });
}
if (miniCover) {
  miniCover.style.cursor = "pointer";
  miniCover.addEventListener("click", () => {
    if (state.currentTrack) openPlayer();
  });
}

let miniPressTimer = null;
let miniPressStart = null;
function cancelMiniPress() {
  if (miniPressTimer) { clearTimeout(miniPressTimer); miniPressTimer = null; }
}

if (typeof document !== "undefined") {
  ["miniDetails", "miniCover"].forEach((idName) => {
    const el = document.getElementById(idName);
    if (!el) return;
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch" || !state.currentTrack) return;
      miniPressStart = { x: e.clientX, y: e.clientY };
      cancelMiniPress();
      miniPressTimer = setTimeout(() => {
        miniPressTimer = null;
        suppressNextClick(el); // гашу хвостовой тап тем же механизмом, что в списках
        openTrackSheet(state.currentTrack);
      }, 400);
    });
    el.addEventListener("pointermove", (e) => {
      if (!miniPressTimer || !miniPressStart) return;
      if (Math.abs(e.clientX - miniPressStart.x) > 10 || Math.abs(e.clientY - miniPressStart.y) > 10) cancelMiniPress();
    });
    el.addEventListener("pointerup", cancelMiniPress);
    el.addEventListener("pointercancel", cancelMiniPress);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  });

  // Escape закрывает sheet (у loginModal своего Escape-обработчика нет)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && trackSheet && !trackSheet.classList.contains("hidden")) closeTrackSheet();
  });
}
