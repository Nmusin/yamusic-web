import { state } from "./state.js";
import { formatDuration, FALLBACK_COVER, toast } from "./util.js";
import { openTrackSheet, suppressNextClick, sheetClickSuppressUntil } from "./track-sheet.js";
import { playTrack } from "./audio-engine.js";
import { switchTab } from "./nav.js";
import {
  searchInput,
  searchClearBtn,
  searchLoader,
  searchResults,
  searchCount,
  likesResults,
  likesLoader,
  likesCount,
  likesRefreshBtn,
  playlistsGrid,
  playlistsLoader,
  playlistsTitle,
  playlistsBackBtn,
  playlistsRefreshBtn,
  playlistTracks,
  smartGrid,
  smartLoader,
  smartRefreshBtn,
} from "./dom.js";

// Search Logic
let searchTimeout = null;
let searchController = null; // отменяет устаревший запрос, если пришёл новый

export function performSearch(query) {
  const q = query.trim();
  if (q.length > 0) {
    if (searchClearBtn) searchClearBtn.classList.remove("hidden");
  } else {
    if (searchClearBtn) searchClearBtn.classList.add("hidden");
  }

  clearTimeout(searchTimeout);
  if (q.length < 2) {
    if (searchCount) searchCount.textContent = "";
    if (searchResults) {
      searchResults.innerHTML = `
        <div class="search-empty-state">
          <i class="fa-solid fa-music"></i>
          <p>Введите запрос или выберите тег сверху</p>
        </div>`;
    }
    return;
  }

  switchTab("tab-search");
  if (searchLoader) searchLoader.classList.remove("hidden");
  if (searchResults) searchResults.innerHTML = "";

  searchTimeout = setTimeout(async () => {
    // Новая обводка отменяет старый in-flight запрос (race: старый ответ мог бы перезаписать новый)
    if (searchController) searchController.abort();
    searchController = new AbortController();
    const ctl = searchController;
    try {
      let searchUrl = `/api/search?q=${encodeURIComponent(q)}`;
      if (state.oauthToken) searchUrl += `&token=${encodeURIComponent(state.oauthToken)}`;
      const res = await fetch(searchUrl, { signal: ctl.signal });
      const data = await res.json();
      if (searchController !== ctl) return; // пришёл более новый запрос
      renderSearchResults(data.tracks || []);
    } catch (e) {
      if (e.name === "AbortError") return;
      if (searchResults) {
        searchResults.innerHTML = `<p style="text-align:center; color:#ff5252; padding:20px;">Ошибка поиска: ${e.message}</p>`;
      }
    } finally {
      if (searchController === ctl) {
        searchController = null;
        if (searchLoader) searchLoader.classList.add("hidden");
      }
    }
  }, 350);
}

if (searchInput) {
  searchInput.addEventListener("input", (e) => {
    performSearch(e.target.value);
  });
  searchInput.addEventListener("focus", () => {
    switchTab("tab-search");
  });
}

if (searchClearBtn) {
  searchClearBtn.addEventListener("click", () => {
    clearTimeout(searchTimeout);
    if (searchController) { searchController.abort(); searchController = null; }
    if (searchInput) searchInput.value = "";
    searchClearBtn.classList.add("hidden");
    if (searchCount) searchCount.textContent = "";
    if (searchResults) {
      searchResults.innerHTML = `
        <div class="search-empty-state">
          <i class="fa-solid fa-music"></i>
          <p>Введите запрос или выберите тег сверху</p>
        </div>`;
    }
  });
}

// Quick Tag Chips
if (typeof document !== "undefined") {
  document.querySelectorAll(".tag-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const q = chip.getAttribute("data-query");
      if (searchInput) searchInput.value = q;
      performSearch(q);
    });
  });
}

// Generic track list renderer (used by Search and Likes)
export function renderTrackList(tracks, container, countEl, countLabel) {
  if (!container) return;
  container.innerHTML = "";
  if (countEl) countEl.textContent = tracks.length > 0 ? `${countLabel || ""} ${tracks.length}`.trim() : "";

  if (tracks.length === 0) {
    container.innerHTML = '<p style="text-align:center; color:#777; padding:40px;">Ничего не найдено</p>';
    return;
  }

  tracks.forEach((track, index) => {
    // Build DOM safely — no innerHTML with user data (XSS)
    const item = document.createElement("div");
    item.className = "track-item";
    item.dataset.trackId = String(track.id);

    const cover = document.createElement("img");
    cover.src = track.coverUri || FALLBACK_COVER;
    cover.alt = "cover";
    cover.onerror = () => { cover.src = FALLBACK_COVER; };

    const info = document.createElement("div");
    info.className = "track-info";
    const titleEl = document.createElement("div");
    titleEl.className = "track-title";
    titleEl.textContent = track.title;
    const artistEl = document.createElement("div");
    artistEl.className = "track-artist";
    artistEl.textContent = track.artists + (track.album ? " • " + track.album : "");
    info.append(titleEl, artistEl);

    const duration = document.createElement("span");
    duration.className = "track-duration";
    duration.textContent = formatDuration(track.durationMs);

    const playBtn = document.createElement("button");
    playBtn.className = "track-play-btn";
    playBtn.title = "Слушать";
    playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';

    item.append(cover, info, duration, playBtn);
    item.addEventListener("click", () => {
      if (Date.now() < sheetClickSuppressUntil) return; // хвост лонг-пресса
      state.radioSessionId = null;
      state.queue = tracks;
      state.queueIndex = index;
      playTrack(track);
      if (container === searchResults) switchTab("tab-search");
    });

    // --- Лонг-пресс (только touch): открыть sheet действий по треку ---
    item.addEventListener("contextmenu", (e) => e.preventDefault());
    let lpTimer = null;
    let lpX = 0, lpY = 0;
    const cancelLongPress = () => {
      if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
    };
    item.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return;
      lpX = e.clientX;
      lpY = e.clientY;
      cancelLongPress();
      lpTimer = setTimeout(() => {
        lpTimer = null;
        openTrackSheet(track);
        suppressNextClick(container);
      }, 400);
    });
    item.addEventListener("pointermove", (e) => {
      if (!lpTimer) return;
      if (Math.abs(e.clientX - lpX) > 10 || Math.abs(e.clientY - lpY) > 10) cancelLongPress();
    });
    item.addEventListener("pointerup", cancelLongPress);
    item.addEventListener("pointercancel", cancelLongPress);
    container.appendChild(item);

    // Mark the track that is already playing in this session (класс + иконка)
    if (state.currentTrack && String(state.currentTrack.id) === String(track.id)) {
      item.classList.add("playing");
      const icon = playBtn.querySelector("i");
      if (icon) icon.className = "fa-solid fa-pause";
    }
  });
}

export function renderSearchResults(tracks) {
  renderTrackList(tracks, searchResults, searchCount, "");
}

// --- Liked Tracks Tab ---
export function showLikesEmpty(msg, icon) {
  if (!likesResults) return;
  likesResults.innerHTML = `
    <div class="likes-empty-state">
      <i class="fa-solid fa-heart${icon === "broken" ? "-crack" : ""}"></i>
      <p>${msg}</p>
    </div>`;
}

export async function loadLikes(force = false) {
  if (state.likesLoading) return;
  if (state.likesLoaded && !force && !state.likesDirty) return;

  if (!state.oauthToken) {
    showLikesEmpty("Войдите в аккаунт, чтобы увидеть лайкнутые треки");
    return;
  }

  state.likesLoading = true;
  if (likesLoader) likesLoader.classList.remove("hidden");
  if (likesResults) likesResults.innerHTML = "";

  try {
    const res = await fetch(`/api/likes?token=${encodeURIComponent(state.oauthToken)}`);
    const data = await res.json();

    if (data.guest) {
      state.likesLoaded = false;
      showLikesEmpty("Токен недействителен — войдите заново", "broken");
    } else {
      state.likesData = data.tracks || [];
      state.likesLoaded = true;
      if (state.likesData.length > 0) {
        renderTrackList(state.likesData, likesResults, likesCount, "");
      } else {
        showLikesEmpty("Пока пусто — лайкайте треки в приложении Яндекс Музыки");
      }
    }
  } catch (e) {
    showLikesEmpty("Ошибка загрузки: " + e.message, "broken");
  } finally {
    state.likesLoading = false;
    if (likesLoader) likesLoader.classList.add("hidden");
  }
}

if (likesRefreshBtn) likesRefreshBtn.addEventListener("click", () => loadLikes(true));

// ===== Playlists =====
let playlistsLoaded = false;
let playlistsLoading = false;
let playlistsData = [];
let currentPlaylistKind = null;

export function showPlaylistsEmpty(msg) {
  if (!playlistsGrid) return;
  playlistsGrid.classList.remove("hidden");
  if (playlistTracks) playlistTracks.classList.add("hidden");
  if (playlistsBackBtn) playlistsBackBtn.classList.add("hidden");
  if (playlistsTitle) playlistsTitle.textContent = "Мои плейлисты";
  playlistsGrid.innerHTML = `
    <div class="likes-empty-state">
      <i class="fa-solid fa-list"></i>
      <p>${msg}</p>
    </div>`;
}

export async function loadPlaylists(force = false) {
  if (playlistsLoading) return;
  if (playlistsLoaded && !force) return;

  if (!state.oauthToken) {
    showPlaylistsEmpty("Войдите в аккаунт, чтобы увидеть плейлисты");
    return;
  }

  playlistsLoading = true;
  if (playlistsLoader) playlistsLoader.classList.remove("hidden");
  try {
    const res = await fetch(`/api/playlists?token=${encodeURIComponent(state.oauthToken)}`);
    const data = await res.json();
    if (data.guest) {
      showPlaylistsEmpty("Токен недействителен — войдите заново");
    } else {
      playlistsData = data.playlists || [];
      playlistsLoaded = true;
      currentPlaylistKind = null;
      renderPlaylistsGrid();
    }
  } catch (e) {
    showPlaylistsEmpty("Ошибка загрузки: " + e.message);
  } finally {
    playlistsLoading = false;
    if (playlistsLoader) playlistsLoader.classList.add("hidden");
  }
}

export function renderPlaylistsGrid() {
  if (!playlistsGrid) return;
  playlistsGrid.classList.remove("hidden");
  if (playlistTracks) playlistTracks.classList.add("hidden");
  if (playlistsBackBtn) playlistsBackBtn.classList.add("hidden");
  if (playlistsTitle) playlistsTitle.textContent = "Мои плейлисты";
  playlistsGrid.innerHTML = "";

  if (playlistsData.length === 0) {
    playlistsGrid.innerHTML =
      '<div class="likes-empty-state"><i class="fa-solid fa-list"></i><p>Плейлисты не найдены</p></div>';
    return;
  }

  playlistsData.forEach((pl) => {
    const card = document.createElement("div");
    card.className = "playlist-card";

    const cover = document.createElement("img");
    cover.src = pl.coverUri || FALLBACK_COVER;
    cover.alt = pl.title;
    cover.onerror = () => { cover.src = FALLBACK_COVER; };

    const meta = document.createElement("div");
    meta.className = "playlist-meta";
    const t = document.createElement("div");
    t.className = "playlist-name";
    t.textContent = pl.title;
    const c = document.createElement("div");
    c.className = "playlist-count";
    const n = pl.trackCount;
    c.textContent = `${n} ${n % 10 === 1 && n % 100 !== 11 ? "трек" : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "трека" : "треков")}`;
    meta.append(t, c);
    card.append(cover, meta);

    card.addEventListener("click", () => openPlaylist(pl));
    playlistsGrid.appendChild(card);
  });
}

export async function openPlaylist(pl) {
  if (playlistsLoader) playlistsLoader.classList.remove("hidden");
  if (playlistsGrid) playlistsGrid.classList.add("hidden");
  currentPlaylistKind = pl.kind;
  try {
    const params = new URLSearchParams({ kind: pl.kind, token: state.oauthToken, uid: pl.uid });
    const res = await fetch(`/api/playlist-tracks?${params.toString()}`);
    const data = await res.json();
    if (playlistsTitle) playlistsTitle.textContent = data.title || pl.title;
    if (playlistTracks) playlistTracks.classList.remove("hidden");
    if (playlistsBackBtn) playlistsBackBtn.classList.remove("hidden");
    renderTrackList(data.tracks || [], playlistTracks, null, "");
    if (!data.tracks || data.tracks.length === 0) {
      if (playlistTracks) {
        playlistTracks.innerHTML =
          '<div class="likes-empty-state"><i class="fa-solid fa-list"></i><p>Плейлист пуст</p></div>';
      }
    }
    // Mark the playing track if it is in this playlist (класс + иконка)
    if (state.currentTrack && playlistTracks) {
      const it = playlistTracks.querySelector(`.track-item[data-track-id="${CSS.escape(String(state.currentTrack.id))}"]`);
      if (it) {
        it.classList.add("playing");
        const icon = it.querySelector(".track-play-btn i");
        if (icon) icon.className = "fa-solid fa-pause";
      }
    }
  } catch (e) {
    toast("Ошибка плейлиста: " + e.message);
    renderPlaylistsGrid();
  } finally {
    if (playlistsLoader) playlistsLoader.classList.add("hidden");
  }
}

if (playlistsBackBtn) playlistsBackBtn.addEventListener("click", () => renderPlaylistsGrid());
if (playlistsRefreshBtn) playlistsRefreshBtn.addEventListener("click", () => loadPlaylists(true));

// ===== Smart Playlists («Подборки») =====
let smartData = [];
let smartLoaded = false;
let smartLoading = false;

export function showSmartEmpty(msg) {
  if (smartGrid) {
    smartGrid.innerHTML = `<div class="likes-empty-state"><i class="fa-solid fa-wand-magic-sparkles"></i><p>${msg}</p></div>`;
  }
}

export async function loadSmart(force = false) {
  if (smartLoading) return;
  if (smartLoaded && !force) return;

  if (!state.oauthToken) {
    showSmartEmpty("Войдите в аккаунт, чтобы увидеть подборки");
    return;
  }

  smartLoading = true;
  if (smartLoader) smartLoader.classList.remove("hidden");
  try {
    const res = await fetch(`/api/smart-playlists?token=${encodeURIComponent(state.oauthToken)}`);
    const data = await res.json();
    if (data.guest) {
      smartLoaded = false;
      showSmartEmpty("Токен недействителен — войдите заново");
    } else {
      smartData = data.playlists || [];
      smartLoaded = true;
      renderSmartGrid();
    }
  } catch (e) {
    showSmartEmpty("Ошибка загрузки: " + e.message);
  } finally {
    smartLoading = false;
    if (smartLoader) smartLoader.classList.add("hidden");
  }
}

export function renderSmartGrid() {
  if (!smartGrid) return;
  smartGrid.innerHTML = "";
  if (smartData.length === 0) {
    showSmartEmpty("Подборки не найдены");
    return;
  }
  smartData.forEach((pl) => {
    const card = document.createElement("div");
    card.className = "playlist-card";

    const cover = document.createElement("img");
    cover.src = pl.coverUri || FALLBACK_COVER;
    cover.alt = pl.title;
    cover.onerror = () => { cover.src = FALLBACK_COVER; };

    const meta = document.createElement("div");
    meta.className = "playlist-meta";
    const t = document.createElement("div");
    t.className = "playlist-name";
    t.textContent = pl.title;
    const c = document.createElement("div");
    c.className = "playlist-count";
    c.textContent = pl.description || "Слушать подборку";
    meta.append(t, c);
    card.append(cover, meta);

    card.addEventListener("click", () => playSmart(pl));
    smartGrid.appendChild(card);
  });
}

export function playSmart(pl) {
  const tracks = pl.tracks || [];
  if (tracks.length === 0) {
    toast("В подборке нет треков");
    return;
  }
  // smart queue replaces both wave and any previous queue
  state.radioSessionId = null;
  state.queue = tracks;
  state.queueIndex = 0;
  playTrack(tracks[0]);
  switchTab("tab-wave");
}

if (smartRefreshBtn) smartRefreshBtn.addEventListener("click", () => loadSmart(true));
