import { state } from "./state.js";
import { toast } from "./util.js";
import { miniLikeBtn, miniLikeIcon, waveLikeIcon, btnLikeWave, fullLikeBtn, fullLikeIcon, likesScreen } from "./dom.js";
import { openLoginModal } from "./auth.js";
import { applySheetHeart } from "./track-sheet.js";
import { loadLikes } from "./tracks-lists.js";

export function trackIdLiked(track) {
  if (!track) return false;
  return state.likedIds.has(String(track.id));
}

// Like button states via class on the wrapper buttons
export function updateHeartUI(liked) {
  const iconClass = liked ? "fa-solid fa-heart" : "fa-regular fa-heart";
  if (miniLikeIcon) {
    miniLikeIcon.className = iconClass;
    if (miniLikeBtn) miniLikeBtn.classList.toggle("liked", liked);
  }
  if (waveLikeIcon) {
    waveLikeIcon.className = iconClass;
    if (btnLikeWave) btnLikeWave.classList.toggle("liked", liked);
  }
  if (fullLikeIcon) {
    fullLikeIcon.className = iconClass;
    if (fullLikeBtn) fullLikeBtn.classList.toggle("liked", liked);
  }
}

export async function refreshLikeState() {
  if (!state.currentTrack) return;
  if (state.likesDirty || !state.likedIds.size) {
    // Pull liked ids in the background if not loaded yet / stale
    if (state.oauthToken && (state.likesDirty || !state.likesLoaded)) {
      try {
        const res = await fetch(`/api/likes?token=${encodeURIComponent(state.oauthToken)}`);
        const data = await res.json();
        if (!data.guest) {
          state.likesData = data.tracks || [];
          state.likesLoaded = true;
          state.likesDirty = false;
          state.likedIds = new Set(state.likesData.map((t) => String(t.id)));
        }
      } catch (e) {}
    }
  }
  updateHeartUI(trackIdLiked(state.currentTrack));
}

// Общий лайк-экшен: мини-плеер, волна и sheet-трек. Task 1: /api/like {remove:0|1}
// поддерживает и добавление, и снятие (likes/tracks/remove, verified live).
export async function likeTrack(target) {
  if (!target) return;
  if (!state.oauthToken) {
    toast("Нужен вход в аккаунт для лайков");
    openLoginModal();
    return;
  }
  const wasLiked = trackIdLiked(target);
  const remove = wasLiked ? 1 : 0;

  try {
    const res = await fetch(`/api/like?token=${encodeURIComponent(state.oauthToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: target.id, albumId: target.albumId, remove }),
    });
    const data = await res.json();
    if (data.ok) {
      if (remove) {
        state.likedIds.delete(String(target.id));
        toast("Убрано из «Мне понравилось»");
      } else {
        state.likedIds.add(String(target.id));
        toast("Добавлено в «Мне понравилось» ❤");
      }
      state.likesDirty = true;
      // Сердца везде синхронно: мини-плеер/волна + sheet-трек (если открыт)
      updateHeartUI(trackIdLiked(state.currentTrack));
      if (state.sheetTrack) applySheetHeart(trackIdLiked(state.sheetTrack));
      refreshLikesTabIfVisible();
    } else {
      toast(data.error || "Не удалось изменить лайк");
    }
  } catch (e) {
    toast("Ошибка сети: " + e.message);
  }
}

export async function toggleLikeCurrent() {
  await likeTrack(state.currentTrack);
}

export function refreshLikesTabIfVisible() {
  if (likesScreen && likesScreen.classList.contains("active") && state.likesLoaded) {
    loadLikes(true);
  }
}

// sync hearts when a new track starts — hook is in updateTrackUI
export function hookTrackUI(track) {
  updateHeartUI(trackIdLiked(track));
  refreshLikeState();
}
