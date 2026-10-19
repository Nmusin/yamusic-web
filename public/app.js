// Yandex Music Web App Player
const audio = document.getElementById("audioElement");

// State
let currentTrack = null;
let queue = [];
let queueIndex = 0;
let isPlaying = false;
let radioSessionId = null;
let isFetchingMore = false;
let playedTrackIds = new Set();
let currentUser = null;
let pollInterval = null;

let quality = localStorage.getItem("ym_quality") || "nq";
let oauthToken = getToken();
let cachedUserStr = localStorage.getItem("ym_user");

// --- Play tracking: report real listening time to Yandex (play-audio) ---
// playId regenerates per track start; playedSeconds accumulates real (non-seek) time
let playReport = { playId: null, playedSeconds: 0, lastPos: 0 };

function startPlayReport() {
  playReport.playId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : "pm-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  playReport.playedSeconds = 0;
  playReport.lastPos = 0;
}

function accumulatePlayTime() {
  const now = audio.currentTime;
  const delta = now - playReport.lastPos;
  // calls tick ~4 Hz; a big positive jump is a seek — not listening time
  if (delta > 0 && delta < 1.5) playReport.playedSeconds += delta;
  playReport.lastPos = now;
}

function sendPlayReport(finished) {
  if (!currentTrack || !playReport.playId) return;
  // Yandex counts a listen from 30 seconds of playback (even partial)
  if (!finished && playReport.playedSeconds < 30) { playReport.playId = null; return; }
  const payload = {
    trackId: String(currentTrack.id),
    albumId: currentTrack.albumId ? String(currentTrack.albumId) : "",
    playId: playReport.playId,
    from: "web-mod",
    playedSeconds: Math.max(1, Math.round(playReport.playedSeconds)),
    trackLengthSeconds: audio.duration && isFinite(audio.duration)
      ? Math.round(audio.duration)
      : Math.round((currentTrack.durationMs || 0) / 1000),
    endPositionSeconds: Math.round(playReport.lastPos),
    finished: !!finished,
  };
  playReport.playId = null; // guard against double-send
  const url = `/api/play-audio${oauthToken ? `?token=${encodeURIComponent(oauthToken)}` : ""}`;
  const body = JSON.stringify(payload);
  try {
    if (oauthToken && navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: "application/json" }))) return;
  } catch (e) {}
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true })
    .catch((e) => console.warn("play-audio report failed:", e));
}

// --- Session memory: очередь + позиция по ключу токена (ym_session:<hash>) ---
let savedPos = 0;      // позиция восстановленного трека (до первого play)
let lastPosSave = 0;   // троттлинг savePosition: не чаще 1 р/5 сек

// Ключ пересчитывается при каждом использовании: oauthToken меняется в
// onLoginSuccess/clearToken, старый ключ нельзя кешировать глобально.
async function tokenKey() {
  const tok = getToken();
  if (tok && crypto && crypto.subtle) {
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

function sessionSource() {
  return radioSessionId ? "Моя Волна" : "Очередь";
}

//_posOverride: позиция момента проигрывания нового трека (иначе audio.currentTime)
async function saveSession(posOverride) {
  if (!queue.length || !currentTrack) return;
  try {
    // Хвост очереди (текущий + следующие), не длиннее 100 треков
    let sliceStart = 0;
    if (queue.length > 100) sliceStart = Math.max(0, queueIndex - 99);
    const kept = queue.slice(sliceStart).map((t) => ({
      id: t.id,
      title: t.title,
      artists: t.artists,
      album: t.album || "",
      albumId: t.albumId || "",
      coverUri: t.coverUri || "",
      durationMs: Number(t.durationMs) || 0,
    }));
    const savedIndex = queueIndex - sliceStart;
    const pos = posOverride !== undefined ? Number(posOverride) || 0 : Math.round(audio.currentTime || savedPos || 0);
    const payload = {
      v: 1,
      queue: kept,
      queueIndex: savedIndex,
      radioSessionId: radioSessionId,
      source: sessionSource(),
      playedTrackIds: Array.from(playedTrackIds).slice(-200),
      pos: pos,
      trackId: String(currentTrack.id),
      token: (getToken() || "").slice(0, 12),
    };
    localStorage.setItem(await tokenKey(), JSON.stringify(payload));
  } catch (e) {
    console.warn("saveSession failed:", e);
  }
}

function savePosition() {
  if (!currentTrack || !audio.currentTime) return;
  const now = Date.now();
  if (now - lastPosSave < 5000) return;
  lastPosSave = now;
  saveSession();
}

// Молчаливое восстановление при загрузке: очередь + мини-плеер в паузе.
// НЕ автостарт: первый playAudio-тап добирает сохранённую позицию из savedPos.
async function restoreSession() {
  try {
    const raw = localStorage.getItem(await tokenKey());
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || data.v !== 1 || !Array.isArray(data.queue) || data.queue.length === 0) return;
    const idx = Math.min(Math.max(0, data.queueIndex || 0), data.queue.length - 1);
    queue = data.queue;
    queueIndex = idx;
    radioSessionId = data.radioSessionId || null;
    playedTrackIds = new Set(Array.isArray(data.playedTrackIds) ? data.playedTrackIds.slice(-200) : []);
    savedPos = Math.max(0, Number(data.pos) || 0);
    const track = queue[queueIndex];
    if (!track) return;

    // Мини-плеер/волна: трек, пауза, прогресс на сохранённой позиции
    updateTrackUI(track);
    setPlayState(false);
    const durSec = (track.durationMs || 0) / 1000;
    if (savedPos && durSec) {
      const fmt = (t) => {
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        return `${m}:${String(s).padStart(2, "0")}`;
      };
      miniProgressFill.style.width = Math.min(100, (savedPos / durSec) * 100) + "%";
      miniTime.textContent = `${fmt(savedPos)} / ${fmt(durSec)}`;
    }
    // Подпись источника на экране волны; waveTrackTitle остаётся от трека
    waveTrackArtist.textContent = "Продолжаем: " + (data.source || sessionSource());
  } catch (e) {
    console.warn("restoreSession failed:", e);
  }
}

// --- Token persistence: localStorage (Android/desktop Chrome) ---
function getToken() {
  try { return localStorage.getItem("ym_token") || ""; } catch (e) { return ""; }
}
function saveToken(token) {
  try { localStorage.setItem("ym_token", token); } catch (e) {}
}
function clearToken() {
  try { localStorage.removeItem("ym_token"); } catch (e) {}
  try { localStorage.removeItem("ym_user"); } catch (e) {}
}
function saveUser(user) {
  try { localStorage.setItem("ym_user", JSON.stringify(user)); } catch (e) {}
}

// UI Elements - Wave
const waveBtn = document.getElementById("waveBtn");
const waveCover = document.getElementById("waveCover");
const wavePlaceholder = document.getElementById("wavePlaceholder");
const waveTrackTitle = document.getElementById("waveTrackTitle");
const waveTrackArtist = document.getElementById("waveTrackArtist");
const waveNextPreview = document.getElementById("waveNextPreview");
const waveNextTitle = document.getElementById("waveNextTitle");
const wavePlayIcon = document.getElementById("wavePlayIcon");
const btnWavePlay = document.getElementById("btnWavePlay");
const btnWavePlayPrev = document.getElementById("btnWavePlayPrev");
const btnDislike = document.getElementById("btnDislike");
// UI Elements - MiniPlayer
const miniPlayer = document.getElementById("miniPlayer");
const miniCover = document.getElementById("miniCover");
const miniTitle = document.getElementById("miniTitle");
const miniArtist = document.getElementById("miniArtist");
const miniPlayBtn = document.getElementById("miniPlayBtn");
const miniPlayIcon = document.getElementById("miniPlayIcon");
const miniNextBtn = document.getElementById("miniNextBtn");
const miniPrevBtn = document.getElementById("miniPrevBtn");
const miniLikeBtn = document.getElementById("miniLikeBtn");
const miniLikeIcon = document.getElementById("miniLikeIcon");
const miniProgressBar = document.getElementById("miniProgressBar");
const miniProgressFill = document.getElementById("miniProgressFill");
const miniTime = document.getElementById("miniTime");

// UI Elements - Full Player Screen (AMOLED, открывается с мини-плеера)
const playerScreen = document.getElementById("playerScreen");
const fullCloseBtn = document.getElementById("fullCloseBtn");
const fullCover = document.getElementById("fullCover");
const fullTitle = document.getElementById("fullTitle");
const fullArtist = document.getElementById("fullArtist");
const fullLikeBtn = document.getElementById("fullLikeBtn");
const fullLikeIcon = document.getElementById("fullLikeIcon");
const fullTimeElapsed = document.getElementById("fullTimeElapsed");
const fullTimeTotal = document.getElementById("fullTimeTotal");
const fullProgress = document.getElementById("fullProgress");
const fullProgressFill = document.getElementById("fullProgressFill");
const fullProgressKnob = document.getElementById("fullProgressKnob");
const fullPrevBtn = document.getElementById("fullPrevBtn");
const fullBack10Btn = document.getElementById("fullBack10Btn");
const fullFwd10Btn = document.getElementById("fullFwd10Btn");
const fullNextBtn = document.getElementById("fullNextBtn");
const fullPlayBtn = document.getElementById("fullPlayBtn");
const fullPlayIcon = document.getElementById("fullPlayIcon");
const fullStopBtn = document.getElementById("fullStopBtn");

// UI Elements - Playlists
const playlistsScreen = document.getElementById("tab-playlists");
const playlistsGrid = document.getElementById("playlistsGrid");
const playlistsLoader = document.getElementById("playlistsLoader");
const playlistsTitle = document.getElementById("playlistsTitle");
const playlistsBackBtn = document.getElementById("playlistsBackBtn");
const playlistsRefreshBtn = document.getElementById("playlistsRefreshBtn");
const playlistTracks = document.getElementById("playlistTracks");

// Like / dislike on Wave and player
const btnLikeWave = document.getElementById("btnLikeWave");
const waveLikeIcon = document.getElementById("waveLikeIcon");

// UI Elements - Search
const searchInput = document.getElementById("searchInput");
const searchClearBtn = document.getElementById("searchClearBtn");
const searchLoader = document.getElementById("searchLoader");
const searchResults = document.getElementById("searchResults");
const searchCount = document.getElementById("searchCount");

// UI Elements - Likes
const likesScreen = document.getElementById("tab-likes");
const likesResults = document.getElementById("likesResults");
const likesLoader = document.getElementById("likesLoader");
const likesCount = document.getElementById("likesCount");
const likesRefreshBtn = document.getElementById("likesRefreshBtn");

// UI Elements - Auth & Profile
const authBtn = document.getElementById("authBtn");
const authBtnText = document.getElementById("authBtnText");
const guestWarningBanner = document.getElementById("guestWarningBanner");
const bannerLoginBtn = document.getElementById("bannerLoginBtn");
const profileAvatar = document.getElementById("profileAvatar");
const profileAvatarPlaceholder = document.getElementById("profileAvatarPlaceholder");
const profileName = document.getElementById("profileName");
const profileStatus = document.getElementById("profileStatus");
const settingsLoginBtn = document.getElementById("settingsLoginBtn");
const settingsLogoutBtn = document.getElementById("settingsLogoutBtn");

// UI Elements - Modal
const loginModal = document.getElementById("loginModal");
const modalBackdrop = document.getElementById("modalBackdrop");
const closeModalBtn = document.getElementById("closeModalBtn");
const deviceCodeLoading = document.getElementById("deviceCodeLoading");
const deviceCodeContainer = document.getElementById("deviceCodeContainer");
const displayUserCode = document.getElementById("displayUserCode");
const openYaDeviceBtn = document.getElementById("openYaDeviceBtn");
const pollingStatusText = document.getElementById("pollingStatusText");
const checkConfirmedBtn = document.getElementById("checkConfirmedBtn");
const manualTokenInput = document.getElementById("manualTokenInput");
const confirmManualTokenBtn = document.getElementById("confirmManualTokenBtn");
const loginError = document.getElementById("loginError");

// Modal Auth Tabs (device / password / token)
const modalTabBtns = document.querySelectorAll(".modal-tab-btn");
const authTabDevice = document.getElementById("authTabDevice");
const authTabPassword = document.getElementById("authTabPassword");
const authTabToken = document.getElementById("authTabToken");
const loginUsername = document.getElementById("loginUsername");
const loginPassword = document.getElementById("loginPassword");
const submitPasswordBtn = document.getElementById("submitPasswordBtn");

// Initialize Quality settings
const qualityRadio = document.querySelector(`input[name="quality"][value="${quality}"]`);
if (qualityRadio) qualityRadio.checked = true;

document.querySelectorAll('input[name="quality"]').forEach((radio) => {
  radio.addEventListener("change", (e) => {
    quality = e.target.value;
    localStorage.setItem("ym_quality", quality);
    if (currentTrack) {
      const curTime = audio.currentTime;
      playTrack(currentTrack, curTime);
    }
  });
});

// Update Track Time Display (e.g. "1:23 / 3:45")
function showTime() {
  if (!miniTime) return;
  const fmt = (t) => {
    if (!isFinite(t)) return "0:00";
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };
  miniTime.textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`;
}

// Small toast notification (instead of alert)
let toastTimer = null;
function toast(msg) {
  if (!toastTimer) {
    const el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
    toastTimer = el;
  }
  toastTimer.textContent = msg;
  toastTimer.classList.add("visible");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    if (toastTimer) toastTimer.classList.remove("visible");
  }, 2500);
}

// Modal Open / Close & Device Code Flow
async function openLoginModal() {
  loginModal.classList.remove("hidden");
  deviceCodeLoading.classList.remove("hidden");
  deviceCodeContainer.classList.add("hidden");
  loginError.classList.add("hidden");
  stopPolling();
  switchAuthTab("device");

  try {
    const res = await fetch("/api/auth/device-code");
    const data = await res.json();

    if (data.ok && data.userCode) {
      displayUserCode.textContent = data.userCode;
      openYaDeviceBtn.href = data.verificationUrl;
      deviceCodeLoading.classList.add("hidden");
      deviceCodeContainer.classList.remove("hidden");

      // Save for the "Я подтвердил вход" button, start background polling
      lastDeviceCode = data.deviceCode;
      startPolling(data.deviceCode, data.interval || 3);
    } else {
      deviceCodeLoading.classList.add("hidden");
      showLoginError(data.error || "Не удалось запросить код входа.");
    }
  } catch (e) {
    deviceCodeLoading.classList.add("hidden");
    showLoginError("Ошибка сети: " + e.message);
  }
}

function closeLoginModal() {
  loginModal.classList.add("hidden");
  stopPolling();
}

function startPolling(deviceCode, intervalSec) {
  stopPolling();
  pollInterval = setInterval(async () => {
    try {
      const res = await fetch(`/api/auth/device-token?deviceCode=${encodeURIComponent(deviceCode)}`);
      const data = await res.json();

      if (data.status === "success" && data.accessToken) {
        stopPolling();
        await onLoginSuccess(data.accessToken);
      } else if (data.status === "error") {
        stopPolling();
        showLoginError("Ошибка авторизации: " + (data.error || "время действия кода истекло."));
      }
    } catch (e) {
      console.error("Poll error:", e);
    }
  }, Math.max(intervalSec, 3) * 1000);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

async function onLoginSuccess(token) {
  oauthToken = token;
  saveToken(token);

  try {
    const res = await fetch(`/api/account?token=${encodeURIComponent(token)}`);
    const data = await res.json();

    if (data.loggedIn && data.user) {
      currentUser = data.user;
      saveUser(data.user);
      updateAuthUI(true);
      closeLoginModal();
      toast(`Добро пожаловать, ${data.user.fullName || data.user.login}!`);
    } else {
      // Token valid at OAuth but account info unavailable — still let user in
      currentUser = { login: "profile", fullName: "Профиль" };
      updateAuthUI(true);
      closeLoginModal();
    }
  } catch (e) {
    currentUser = { login: "profile", fullName: "Профиль" };
    updateAuthUI(true);
    closeLoginModal();
  }

  // Refresh likes after login
  likesLoaded = false;
  if (likesScreen.classList.contains("active")) loadLikes(true);

  // If currently playing 30s preview, restart full track
  if (currentTrack) {
    playTrack(currentTrack, audio.currentTime);
  }
}

function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove("hidden");
}

authBtn.addEventListener("click", () => {
  if (currentUser) {
    switchTab("tab-settings");
  } else {
    openLoginModal();
  }
});
bannerLoginBtn.addEventListener("click", openLoginModal);
settingsLoginBtn.addEventListener("click", openLoginModal);
closeModalBtn.addEventListener("click", closeLoginModal);
modalBackdrop.addEventListener("click", closeLoginModal);

// --- Manual Token Tab ---
confirmManualTokenBtn.addEventListener("click", () => {
  let token = manualTokenInput.value.trim();
  const match = token.match(/access_token=([^&]+)/);
  if (match) token = match[1];

  if (!token) {
    showLoginError("Введите токен");
    return;
  }
  onLoginSuccess(token);
});
manualTokenInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") confirmManualTokenBtn.click();
});

// --- Password Tab ---
async function submitPasswordLogin() {
  const username = loginUsername.value.trim();
  const password = loginPassword.value;

  if (!username || !password) {
    showLoginError("Укажите логин и пароль");
    return;
  }

  submitPasswordBtn.disabled = true;
  submitPasswordBtn.textContent = "Входим...";
  loginError.classList.add("hidden");

  try {
    const res = await fetch("/api/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();

    if (data.ok && data.accessToken) {
      onLoginSuccess(data.accessToken);
    } else {
      showLoginError(data.error || "Ошибка авторизации");
    }
  } catch (e) {
    showLoginError("Ошибка сети: " + e.message);
  } finally {
    submitPasswordBtn.disabled = false;
    submitPasswordBtn.textContent = "Войти";
  }
}
submitPasswordBtn.addEventListener("click", submitPasswordLogin);
loginPassword.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitPasswordLogin();
});

// --- Modal Tab Switching (device / password / token) ---
function switchAuthTab(name) {
  const map = {
    device: [authTabDevice, "auth-device"],
    password: [authTabPassword, "auth-password"],
    token: [authTabToken, "auth-token"],
  };
  modalTabBtns.forEach((b) => b.classList.toggle("active", b.getAttribute("data-auth") === name));
  Object.entries(map).forEach(([key, [el]]) => {
    if (el) el.classList.toggle("active", key === name);
  });
  loginError.classList.add("hidden");
}
modalTabBtns.forEach((btn) => {
  btn.addEventListener("click", () => switchAuthTab(btn.getAttribute("data-auth")));
});

// --- "Я подтвердил вход" — force immediate token check ---
let lastDeviceCode = null;
checkConfirmedBtn.addEventListener("click", async () => {
  if (!lastDeviceCode) return;
  pollingStatusText.textContent = "Проверяем...";
  try {
    const res = await fetch(`/api/auth/device-token?deviceCode=${encodeURIComponent(lastDeviceCode)}`);
    const data = await res.json();
    if (data.status === "success" && data.accessToken) {
      stopPolling();
      onLoginSuccess(data.accessToken);
    } else if (data.status === "pending") {
      pollingStatusText.textContent = "Ещё не подтверждено — проверьте ya.ru/device";
    } else {
      stopPolling();
      showLoginError("Ошибка авторизации: " + (data.error || "код истёк"));
    }
  } catch (e) {
    pollingStatusText.textContent = "Ошибка сети";
  }
});

// Logout
settingsLogoutBtn.addEventListener("click", () => {
  if (confirm("Вы действительно хотите выйти из аккаунта?")) {
    oauthToken = "";
    currentUser = null;
    clearToken();
    updateAuthUI(false);
    // Reset likes tab to the logged-out state
    likesData = [];
    likesLoaded = false;
    showLikesEmpty("Войдите в аккаунт, чтобы увидеть лайкнутые треки");
    likesCount.textContent = "";
  }
});

function updateAuthUI(isLoggedIn) {
  if (isLoggedIn && currentUser) {
    guestWarningBanner.classList.add("hidden");
    authBtnText.textContent = currentUser.login || "Профиль";
    authBtn.style.background = "#2a2a2a";
    authBtn.style.color = "#ffcc00";

    profileName.textContent = currentUser.fullName || currentUser.login;
    profileStatus.textContent = "Аккаунт подключен • Плюс разблокирован";
    if (currentUser.avatarUrl) {
      profileAvatar.src = currentUser.avatarUrl;
      profileAvatar.classList.remove("hidden");
      profileAvatarPlaceholder.classList.add("hidden");
    } else {
      profileAvatar.classList.add("hidden");
      profileAvatarPlaceholder.classList.remove("hidden");
    }

    settingsLoginBtn.classList.add("hidden");
    settingsLogoutBtn.classList.remove("hidden");
  } else {
    guestWarningBanner.classList.remove("hidden");
    authBtnText.textContent = "Войти";
    authBtn.style.background = "#ffcc00";
    authBtn.style.color = "#000";

    profileName.textContent = "Не авторизован";
    profileStatus.textContent = "Без аккаунта треки длятся 30 секунд";
    profileAvatar.classList.add("hidden");
    profileAvatarPlaceholder.classList.remove("hidden");

    settingsLoginBtn.classList.remove("hidden");
    settingsLogoutBtn.classList.add("hidden");
  }
}

// Check initial token on startup
if (oauthToken) {
  // Render cached profile instantly (no waiting for network)
  if (cachedUserStr) {
    try {
      currentUser = JSON.parse(cachedUserStr);
      updateAuthUI(true);
    } catch (e) {}
  }

  // Session memory: молчаливое восстановление очереди и позиции
  restoreSession();

  // Re-validate the token in the background
  fetch(`/api/account?token=${encodeURIComponent(oauthToken)}`)
    .then((r) => r.json())
    .then((data) => {
      if (data.loggedIn && data.user) {
        currentUser = data.user;
        saveUser(data.user);
        updateAuthUI(true);
      } else {
        currentUser = null;
        clearToken();
        updateAuthUI(false);
        toast("Сессия истекла, войдите заново");
      }
    })
    .catch(() => {
      // Network error — keep cached session, don't log the user out
    });
} else {
  updateAuthUI(false);
  // Гость тоже восстанавливает сохранённую сессию (отдельный ключ)
  restoreSession();
}

// Tab Navigation
function switchTab(tabId) {
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-tab") === tabId);
  });
  document.querySelectorAll(".tab-content").forEach((c) => {
    c.classList.toggle("active", c.id === tabId);
  });
}

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tabId = btn.getAttribute("data-tab");
    switchTab(tabId);
    // Load likes/playlists lazily on first open
    if (tabId === "tab-likes") loadLikes();
    if (tabId === "tab-playlists") loadPlaylists();
    if (tabId === "tab-smart") loadSmart();
  });
});

// Spacebar play/pause (except when typing in inputs)
document.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || loginModal.classList.contains("hidden") === false) return;
  if (e.code === "Space") {
    e.preventDefault();
    togglePlayPause();
  }
});

// Play Track
let pendingSeek = 0;
let consecutiveErrors = 0;

async function sendRotorFeedback(type) {
  if (!radioSessionId || !currentTrack) return;
  try {
    await fetch(
      `/api/rotor/feedback${oauthToken ? `?token=${encodeURIComponent(oauthToken)}` : ""}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          station: "user:onyourwave",
          type,
          trackId: String(currentTrack.id),
          from: type === "radioStarted" ? "web-mod" : undefined,
        }),
      }
    );
  } catch (e) {
    console.warn("Rotor feedback failed:", e);
  }
}

function playTrack(track, seekTo = 0) {
  if (!track) return;
  const isWaveTrack = !!radioSessionId;
  currentTrack = track;
  playedTrackIds.add(String(track.id));
  hideWaveEnded(); // новый трек отменяет состояние «Очередь закончилась»
  saveSession(seekTo || 0);

  // Stream URL
  let streamUrl = `/api/stream?id=${encodeURIComponent(track.id)}&quality=${quality}`;
  if (oauthToken) streamUrl += `&token=${encodeURIComponent(oauthToken)}`;

  // currentTime can only be set after metadata is loaded
  pendingSeek = seekTo || 0;
  audio.src = streamUrl;
  if (pendingSeek > 0) {
    audio.addEventListener("loadedmetadata", () => {
      try { audio.currentTime = pendingSeek; } catch (e) {}
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
  if (radioSessionId && queue.length - queueIndex <= 2) {
    fetchMoreWaveTracks();
  }
}

function updateTrackUI(track) {
  // Wave UI
  waveTrackTitle.textContent = track.title;
  waveTrackArtist.textContent = track.artists;
  if (track.coverUri) {
    waveCover.src = track.coverUri;
    waveCover.classList.remove("hidden");
    wavePlaceholder.classList.add("hidden");
  } else {
    waveCover.classList.add("hidden");
    wavePlaceholder.classList.remove("hidden");
  }

  // MiniPlayer UI
  miniTitle.textContent = track.title;
  miniArtist.textContent = track.artists;
  miniCover.src = track.coverUri || FALLBACK_COVER;

  // Full player screen UI
  updateFullPlayerUI(track);

  // Highlight currently playing track in search/likes/playlist lists.
  // Сначала полный сброс: класс + иконка на ВСЕХ ранее подсвеченных элементах,
  // иначе у прошлого трека навсегда остаётся fa-pause.
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

  hookTrackUI(track);
}

function updateNextPreview() {
  const nextTrack = queue[queueIndex + 1];
  if (nextTrack) {
    waveNextTitle.textContent = `${nextTrack.title} — ${nextTrack.artists}`;
    waveNextPreview.classList.remove("hidden");
  } else {
    waveNextPreview.classList.add("hidden");
  }
}

function setPlayState(playing) {
  isPlaying = playing;
  if (playing) {
    waveBtn.classList.add("playing");
    wavePlayIcon.className = "fa-solid fa-pause";
    miniPlayIcon.className = "fa-solid fa-pause";
    fullPlayIcon.className = "fa-solid fa-pause";
  } else {
    waveBtn.classList.remove("playing");
    wavePlayIcon.className = "fa-solid fa-play";
    miniPlayIcon.className = "fa-solid fa-play";
    fullPlayIcon.className = "fa-solid fa-play";
  }
}

// Audio Element Events
audio.addEventListener("play", () => { consecutiveErrors = 0; setPlayState(true); });
audio.addEventListener("pause", () => setPlayState(false));
audio.addEventListener("loadedmetadata", () => showTime());
audio.addEventListener("timeupdate", () => {
  accumulatePlayTime();
  savePosition();
    if (audio.duration) {
      const percent = (audio.currentTime / audio.duration) * 100;
      miniProgressFill.style.width = percent + "%";
      updateFullProgress();
      showTime();
    }
});
// Auto-skip broken streams, but never loop endlessly on a broken connection
audio.addEventListener("error", () => {
  if (!currentTrack) return;
  consecutiveErrors++;
  if (consecutiveErrors >= 5) {
    toast("Ошибка воспроизведения, остановлено");
    audio.pause();
    consecutiveErrors = 0;
    return;
  }
  toast("Трек недоступен, пропускаем...");
  setTimeout(playNext, 600);
});
audio.addEventListener("ended", () => {
  playNext();
});

// Controls
function togglePlayPause() {
  if (!currentTrack) {
    // Восстановленная сессия: первый тап play продолжает с сохранённой позиции
    if (queue.length > 0 && queue[queueIndex]) {
      const resumeFrom = savedPos;
      savedPos = 0;
      playTrack(queue[queueIndex], resumeFrom);
      return;
    }
    startWave();
    return;
  }
  if (audio.paused) {
    audio.play();
  } else {
    audio.pause();
  }
}

function playPrev() {
  if (queueIndex > 0) {
    queueIndex--;
    playTrack(queue[queueIndex]);
    saveSession(0);
  } else if (audio.currentTime > 3) {
    // Restart current track like real players do
    audio.currentTime = 0;
  }
}

async function playNext() {
  // Report the finished/abandoned track before switching away from it
  sendPlayReport(!!audio.ended);
  if (radioSessionId && currentTrack) sendRotorFeedback("skip");
  if (queueIndex < queue.length - 1) {
    queueIndex++;
    playTrack(queue[queueIndex]);
    saveSession(0);
  } else {
    if (radioSessionId) {
      waveTrackTitle.textContent = "Загрузка новых треков...";
      waveTrackArtist.textContent = "Волна продолжается";
      await fetchMoreWaveTracks();
      if (queueIndex < queue.length - 1) {
        queueIndex++;
        playTrack(queue[queueIndex]);
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

btnWavePlay.addEventListener("click", togglePlayPause);
waveBtn.addEventListener("click", togglePlayPause);
miniPlayBtn.addEventListener("click", togglePlayPause);
btnWavePlayPrev.addEventListener("click", playPrev);
miniPrevBtn.addEventListener("click", playPrev);
miniNextBtn.addEventListener("click", playNext);
miniLikeBtn.addEventListener("click", toggleLikeCurrent);
btnLikeWave.addEventListener("click", toggleLikeCurrent);
btnDislike.addEventListener("click", dislikeAndSkip);

miniProgressBar.addEventListener("click", (e) => {
  if (!audio.duration) return;
  const rect = miniProgressBar.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const percent = clickX / rect.width;
  audio.currentTime = percent * audio.duration;
});

// "Моя Волна" Continuous Fetch (NO LOOPS / REPEATS)
async function startWave() {
  hideWaveEnded();
  waveTrackTitle.textContent = "Запуск Волны...";
  waveTrackArtist.textContent = "Подбираем треки...";
  radioSessionId = null;
  queue = [];
  queueIndex = 0;

  let waveUrl = "/api/wave";
  if (oauthToken) waveUrl += `?token=${encodeURIComponent(oauthToken)}`;

  try {
    const resp = await fetch(waveUrl);
    const data = await resp.json();
    if (data.tracks && data.tracks.length > 0) {
      radioSessionId = data.radioSessionId || null;
      const freshTracks = data.tracks.filter((t) => !playedTrackIds.has(String(t.id)));
      queue = freshTracks.length > 0 ? freshTracks : data.tracks;
      queueIndex = 0;
      // Inform the rotor that a new radio session has begun
      if (radioSessionId) {
        try {
          await fetch(
            `/api/rotor/feedback${oauthToken ? `?token=${encodeURIComponent(oauthToken)}` : ""}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ station: "user:onyourwave", type: "radioStarted", from: "web-mod" }),
            }
          );
        } catch (e) {}
      }
      // playTrack() itself sends "trackStarted" because radioSessionId is set
      playTrack(queue[0]);
    } else {
      waveTrackTitle.textContent = "Ошибка загрузки";
      waveTrackArtist.textContent = "Попробуйте еще раз";
    }
  } catch (e) {
    waveTrackTitle.textContent = "Ошибка сети";
    waveTrackArtist.textContent = e.message;
  }
}

async function fetchMoreWaveTracks() {
  if (isFetchingMore || !radioSessionId) return;
  isFetchingMore = true;

  try {
    let nextUrl = `/api/wave?sessionId=${encodeURIComponent(radioSessionId)}`;
    if (oauthToken) nextUrl += `&token=${encodeURIComponent(oauthToken)}`;

    const resp = await fetch(nextUrl);
    const data = await resp.json();
    if (data.tracks && data.tracks.length > 0) {
      if (data.radioSessionId) radioSessionId = data.radioSessionId;

      const newTracks = data.tracks.filter((t) => !playedTrackIds.has(String(t.id)));
      if (newTracks.length > 0) {
        queue.push(...newTracks);
      } else {
        queue.push(...data.tracks);
      }
      updateNextPreview();
    }
  } catch (e) {
    console.error("Error fetching more wave tracks:", e);
  } finally {
    isFetchingMore = false;
  }
}

// Search Logic
let searchTimeout = null;
let searchController = null; // отменяет устаревший запрос, если пришёл новый

function performSearch(query) {
  const q = query.trim();
  if (q.length > 0) {
    searchClearBtn.classList.remove("hidden");
  } else {
    searchClearBtn.classList.add("hidden");
  }

  clearTimeout(searchTimeout);
  if (q.length < 2) {
    searchCount.textContent = "";
    searchResults.innerHTML = `
      <div class="search-empty-state">
        <i class="fa-solid fa-music"></i>
        <p>Введите запрос или выберите тег сверху</p>
      </div>`;
    return;
  }

  switchTab("tab-search");
  searchLoader.classList.remove("hidden");
  searchResults.innerHTML = "";

  searchTimeout = setTimeout(async () => {
    // Новая обводка отменяет старый in-flight запрос (race: старый ответ мог бы перезаписать новый)
    if (searchController) searchController.abort();
    searchController = new AbortController();
    const ctl = searchController;
    try {
      let searchUrl = `/api/search?q=${encodeURIComponent(q)}`;
      if (oauthToken) searchUrl += `&token=${encodeURIComponent(oauthToken)}`;
      const res = await fetch(searchUrl, { signal: ctl.signal });
      const data = await res.json();
      if (searchController !== ctl) return; // пришёл более новый запрос
      renderSearchResults(data.tracks || []);
    } catch (e) {
      if (e.name === "AbortError") return;
      searchResults.innerHTML = `<p style="text-align:center; color:#ff5252; padding:20px;">Ошибка поиска: ${e.message}</p>`;
    } finally {
      if (searchController === ctl) {
        searchController = null;
        searchLoader.classList.add("hidden");
      }
    }
  }, 350);
}

searchInput.addEventListener("input", (e) => {
  performSearch(e.target.value);
});

searchInput.addEventListener("focus", () => {
  switchTab("tab-search");
});

searchClearBtn.addEventListener("click", () => {
  clearTimeout(searchTimeout);
  if (searchController) { searchController.abort(); searchController = null; }
  searchInput.value = "";
  searchClearBtn.classList.add("hidden");
  searchCount.textContent = "";
  searchResults.innerHTML = `
    <div class="search-empty-state">
      <i class="fa-solid fa-music"></i>
      <p>Введите запрос или выберите тег сверху</p>
    </div>`;
});

// Quick Tag Chips
document.querySelectorAll(".tag-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const q = chip.getAttribute("data-query");
    searchInput.value = q;
    performSearch(q);
  });
});

function formatDuration(ms) {
  if (!ms) return "";
  return `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
}

// Safe cover placeholder (SVG data URI)
const FALLBACK_COVER = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#2a2a2a"/><text x="24" y="30" font-size="20" text-anchor="middle" fill="#555">♪</text></svg>'
);

// Suppress the click that always follows a long-press. Flag + capture-phase
// once-listener on the list container: the capture stop happens before the
// item's bubble handler can start playback.
let sheetClickSuppressUntil = 0;
// container -> drain-listener: максимум один живой подавитель на контейнер,
// иначе once-анонимные листенеры накапливаются на постоянных контейнерах.
const sheetClickDrains = new Map();
function suppressNextClick(container) {
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

// Generic track list renderer (used by Search and Likes)
function renderTrackList(tracks, container, countEl, countLabel) {
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
      radioSessionId = null;
      queue = tracks;
      queueIndex = index;
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
    if (currentTrack && String(currentTrack.id) === String(track.id)) {
      item.classList.add("playing");
      const icon = playBtn.querySelector("i");
      if (icon) icon.className = "fa-solid fa-pause";
    }
  });
}

function renderSearchResults(tracks) {
  renderTrackList(tracks, searchResults, searchCount, "");
}

// --- Liked Tracks Tab ---
let likesData = [];
let likesLoaded = false;
let likesLoading = false;

function showLikesEmpty(msg, icon) {
  likesResults.innerHTML = `
    <div class="likes-empty-state">
      <i class="fa-solid fa-heart${icon === "broken" ? "-crack" : ""}"></i>
      <p>${msg}</p>
    </div>`;
}

async function loadLikes(force = false) {
  if (likesLoading) return;
  if (likesLoaded && !force && !likesDirty) return;

  if (!oauthToken) {
    showLikesEmpty("Войдите в аккаунт, чтобы увидеть лайкнутые треки");
    return;
  }

  likesLoading = true;
  likesLoader.classList.remove("hidden");
  likesResults.innerHTML = "";

  try {
    const res = await fetch(`/api/likes?token=${encodeURIComponent(oauthToken)}`);
    const data = await res.json();

    if (data.guest) {
      likesLoaded = false;
      showLikesEmpty("Токен недействителен — войдите заново", "broken");
    } else {
      likesData = data.tracks || [];
      likesLoaded = true;
      if (likesData.length > 0) {
        renderTrackList(likesData, likesResults, likesCount, "");
      } else {
        showLikesEmpty("Пока пусто — лайкайте треки в приложении Яндекс Музыки");
      }
    }
  } catch (e) {
    showLikesEmpty("Ошибка загрузки: " + e.message, "broken");
  } finally {
    likesLoading = false;
    likesLoader.classList.add("hidden");
  }
}

likesRefreshBtn.addEventListener("click", () => loadLikes(true));

// ===== Real Like / Dislike =====
let likedIds = new Set();
let likesDirty = false; // likes list needs refetch after manual changes

function trackIdLiked(track) {
  if (!track) return false;
  return likedIds.has(String(track.id));
}

// Like button states via class on the wrapper buttons
function updateHeartUI(liked) {
  const iconClass = liked ? "fa-solid fa-heart" : "fa-regular fa-heart";
  if (miniLikeIcon) {
    miniLikeIcon.className = iconClass;
    miniLikeBtn.classList.toggle("liked", liked);
  }
  if (waveLikeIcon) {
    waveLikeIcon.className = iconClass;
    btnLikeWave.classList.toggle("liked", liked);
  }
  if (fullLikeIcon) {
    fullLikeIcon.className = iconClass;
    fullLikeBtn.classList.toggle("liked", liked);
  }
}

async function refreshLikeState() {
  if (!currentTrack) return;
  if (likesDirty || !likedIds.size) {
    // Pull liked ids in the background if not loaded yet / stale
    if (oauthToken && (likesDirty || !likesLoaded)) {
      try {
        const res = await fetch(`/api/likes?token=${encodeURIComponent(oauthToken)}`);
        const data = await res.json();
        if (!data.guest) {
          likesData = data.tracks || [];
          likesLoaded = true;
          likesDirty = false;
          likedIds = new Set(likesData.map((t) => String(t.id)));
        }
      } catch (e) {}
    }
  }
  updateHeartUI(trackIdLiked(currentTrack));
}

// Общий лайк-экшен: мини-плеер, волна и sheet-трек. Task 1: /api/like {remove:0|1}
// поддерживает и добавление, и снятие (likes/tracks/remove, verified live).
async function likeTrack(target) {
  if (!target) return;
  if (!oauthToken) {
    toast("Нужен вход в аккаунт для лайков");
    openLoginModal();
    return;
  }
  const wasLiked = trackIdLiked(target);
  const remove = wasLiked ? 1 : 0;

  try {
    const res = await fetch(`/api/like?token=${encodeURIComponent(oauthToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: target.id, albumId: target.albumId, remove }),
    });
    const data = await res.json();
    if (data.ok) {
      if (remove) {
        likedIds.delete(String(target.id));
        toast("Убрано из «Мне понравилось»");
      } else {
        likedIds.add(String(target.id));
        toast("Добавлено в «Мне понравилось» ❤");
      }
      likesDirty = true;
      // Сердца везде синхронно: мини-плеер/волна + sheet-трек (если открыт)
      updateHeartUI(trackIdLiked(currentTrack));
      if (sheetTrack) applySheetHeart(trackIdLiked(sheetTrack));
      refreshLikesTabIfVisible();
    } else {
      toast(data.error || "Не удалось изменить лайк");
    }
  } catch (e) {
    toast("Ошибка сети: " + e.message);
  }
}

async function toggleLikeCurrent() {
  await likeTrack(currentTrack);
}

function refreshLikesTabIfVisible() {
  if (likesScreen.classList.contains("active") && likesLoaded) loadLikes(true);
}

// ===== Track Actions Sheet (лонг-пресс / тап по мини-плееру) =====
const trackSheet = document.getElementById("trackSheet");
const sheetBackdrop = document.getElementById("sheetBackdrop");
const sheetCover = document.getElementById("sheetCover");
const sheetTitle = document.getElementById("sheetTitle");
const sheetSub = document.getElementById("sheetSub");
const sheetLikeBtn = document.getElementById("sheetLikeBtn");
const sheetLikeIcon = document.getElementById("sheetLikeIcon");
const sheetNextBtn = document.getElementById("sheetNextBtn");
const sheetPlayBtn = document.getElementById("sheetPlayBtn");
const sheetCloseBtn = document.getElementById("sheetCloseBtn");
const miniDetails = document.getElementById("miniDetails");
const waveEnded = document.getElementById("waveEnded");
const waveEndedBtn = document.getElementById("waveEndedBtn");

let sheetTrack = null;
let sheetOpenedAt = 0;

function applySheetHeart(liked) {
  sheetLikeIcon.className = liked ? "fa-solid fa-heart" : "fa-regular fa-heart";
  sheetLikeBtn.classList.toggle("liked", liked);
}

// Сердце sheet-трека: локальное состояние (likedIds) мгновенно; если общий
// список лайков ещё не подгружен/краснеет после изменений (likesDirty) —
// точечная проверка батч-эндпоинтом /api/like-status, без ломающего
// refreshLikeState.
async function refreshSheetLikeState() {
  if (!sheetTrack) return;
  const track = sheetTrack;
  applySheetHeart(trackIdLiked(track));
  if (!oauthToken || (likesLoaded && !likesDirty)) return;
  try {
    const res = await fetch(
      `/api/like-status?ids=${encodeURIComponent(String(track.id))}` +
      `&token=${encodeURIComponent(oauthToken)}`
    );
    const data = await res.json();
    const liked = (data.likedIds || []).includes(String(track.id));
    if (liked) likedIds.add(String(track.id));
    else likedIds.delete(String(track.id));
    if (sheetTrack === track) applySheetHeart(liked);
  } catch (e) {}
}

function openTrackSheet(track) {
  if (!track) return;
  sheetTrack = track;
  sheetTitle.textContent = track.title;
  // «артисты · альбом · mm:ss»
  sheetSub.textContent = [track.artists, track.album, formatDuration(track.durationMs)]
    .filter(Boolean).join(" · ");
  sheetCover.onerror = () => { sheetCover.src = FALLBACK_COVER; };
  sheetCover.src = track.coverUri || FALLBACK_COVER;
  sheetOpenedAt = Date.now();
  trackSheet.classList.remove("hidden");
  refreshSheetLikeState();
}

function closeTrackSheet() {
  trackSheet.classList.add("hidden");
  sheetTrack = null;
  // Флаг подавления не должен переживать sheet: иначе первый легитимный тап
  // по треку заглохнет, если после лонг-пресса пользователя закрыл sheet
  // крестиком (click мимо контейнера списка, окно 800 мс оставалось живым).
  sheetClickSuppressUntil = 0;
}

// «Следом»: в волне очередь ведёт Яндекс — не вставляем
function addTrackNext() {
  if (!sheetTrack) return;
  if (radioSessionId !== null) {
    toast("В волне очередь ведёт Яндекс");
    return;
  }
  queue.splice(queueIndex + 1, 0, sheetTrack);
  toast("Следом за текущим");
  saveSession(); // внутри игнорируется, если currentTrack нет
}

// «Слушать»: вне радио — очередь из одного трека, как из поиска
function playTrackFromSheet() {
  if (!sheetTrack) return;
  radioSessionId = null;
  queue = [sheetTrack];
  queueIndex = 0;
  playTrack(sheetTrack); // прячет плашку конца очереди, сохраняет сессию
  closeTrackSheet();
}

sheetCloseBtn.addEventListener("click", closeTrackSheet);
sheetBackdrop.addEventListener("click", closeTrackSheetFromBackdrop);
sheetLikeBtn.addEventListener("click", () => likeTrack(sheetTrack));
sheetNextBtn.addEventListener("click", addTrackNext);
sheetPlayBtn.addEventListener("click", playTrackFromSheet);
// Мини-плеер: тап по инфо-зоне/обложке → полный экран плеера;
// лонг-пресс → карточка трека (как в списках: тап — крупное действие).
miniDetails.addEventListener("click", () => {
  if (currentTrack) openPlayer();
});
miniCover.style.cursor = "pointer";
miniCover.addEventListener("click", () => {
  if (currentTrack) openPlayer();
});
let miniPressTimer = null;
let miniPressStart = null;
function cancelMiniPress() {
  if (miniPressTimer) { clearTimeout(miniPressTimer); miniPressTimer = null; }
}
["miniDetails", "miniCover"].forEach((idName) => {
  const el = document.getElementById(idName);
  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch" || !currentTrack) return;
    miniPressStart = { x: e.clientX, y: e.clientY };
    cancelMiniPress();
    miniPressTimer = setTimeout(() => {
      miniPressTimer = null;
      suppressNextClick(el); // гашу хвостовой тап тем же механизмом, что в списках
      openTrackSheet(currentTrack);
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

// Клик по только что открывшемуся backdrop — это хвост касания от лонг-пресса,
// не попытка закрыть: игнорируем первые 500 мс.
function closeTrackSheetFromBackdrop() {
  if (Date.now() - sheetOpenedAt < 500) return;
  closeTrackSheet();
}

// Escape закрывает sheet (у loginModal своего Escape-обработчика нет)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !trackSheet.classList.contains("hidden")) closeTrackSheet();
});

// ===== Конец очереди (вне волны) =====
function showWaveEnded() {
  waveTrackTitle.textContent = "Очередь закончилась";
  waveTrackArtist.textContent = "Волна не запущена";
  waveEnded.classList.remove("hidden");
}

function hideWaveEnded() {
  waveEnded.classList.add("hidden");
}

waveEndedBtn.addEventListener("click", () => {
  hideWaveEnded();
  startWave();
});

async function dislikeAndSkip() {
  if (radioSessionId && currentTrack) sendRotorFeedback("dislike");
  toast("Дизлайк учтён, перематываем");
  await playNext();
}

// sync hearts when a new track starts — hook is in updateTrackUI
function hookTrackUI(track) {
  updateHeartUI(trackIdLiked(track));
  refreshLikeState();
}

// ===== Playlists =====
let playlistsLoaded = false;
let playlistsLoading = false;
let playlistsData = [];
let currentPlaylistKind = null;

function showPlaylistsEmpty(msg) {
  playlistsGrid.classList.remove("hidden");
  playlistTracks.classList.add("hidden");
  playlistsBackBtn.classList.add("hidden");
  playlistsTitle.textContent = "Мои плейлисты";
  playlistsGrid.innerHTML = `
    <div class="likes-empty-state">
      <i class="fa-solid fa-list"></i>
      <p>${msg}</p>
    </div>`;
}

async function loadPlaylists(force = false) {
  if (playlistsLoading) return;
  if (playlistsLoaded && !force) return;

  if (!oauthToken) {
    showPlaylistsEmpty("Войдите в аккаунт, чтобы увидеть плейлисты");
    return;
  }

  playlistsLoading = true;
  playlistsLoader.classList.remove("hidden");
  try {
    const res = await fetch(`/api/playlists?token=${encodeURIComponent(oauthToken)}`);
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
    playlistsLoader.classList.add("hidden");
  }
}

function renderPlaylistsGrid() {
  playlistsGrid.classList.remove("hidden");
  playlistTracks.classList.add("hidden");
  playlistsBackBtn.classList.add("hidden");
  playlistsTitle.textContent = "Мои плейлисты";
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

async function openPlaylist(pl) {
  playlistsLoader.classList.remove("hidden");
  playlistsGrid.classList.add("hidden");
  currentPlaylistKind = pl.kind;
  try {
    const params = new URLSearchParams({ kind: pl.kind, token: oauthToken, uid: pl.uid });
    const res = await fetch(`/api/playlist-tracks?${params.toString()}`);
    const data = await res.json();
    playlistsTitle.textContent = data.title || pl.title;
    playlistTracks.classList.remove("hidden");
    playlistsBackBtn.classList.remove("hidden");
    renderTrackList(data.tracks || [], playlistTracks, null, "");
    if (!data.tracks || data.tracks.length === 0) {
      playlistTracks.innerHTML =
        '<div class="likes-empty-state"><i class="fa-solid fa-list"></i><p>Плейлист пуст</p></div>';
    }
    // Mark the playing track if it is in this playlist (класс + иконка)
    if (currentTrack) {
      const it = playlistTracks.querySelector(`.track-item[data-track-id="${CSS.escape(String(currentTrack.id))}"]`);
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
    playlistsLoader.classList.add("hidden");
  }
}

playlistsBackBtn.addEventListener("click", () => renderPlaylistsGrid());
playlistsRefreshBtn.addEventListener("click", () => loadPlaylists(true));

// ===== Smart Playlists («Подборки») =====
const smartGrid = document.getElementById("smartGrid");
const smartLoader = document.getElementById("smartLoader");
const smartRefreshBtn = document.getElementById("smartRefreshBtn");

let smartData = [];
let smartLoaded = false;
let smartLoading = false;

function showSmartEmpty(msg) {
  smartGrid.innerHTML = `<div class="likes-empty-state"><i class="fa-solid fa-wand-magic-sparkles"></i><p>${msg}</p></div>`;
}

async function loadSmart(force = false) {
  if (smartLoading) return;
  if (smartLoaded && !force) return;

  if (!oauthToken) {
    showSmartEmpty("Войдите в аккаунт, чтобы увидеть подборки");
    return;
  }

  smartLoading = true;
  smartLoader.classList.remove("hidden");
  try {
    const res = await fetch(`/api/smart-playlists?token=${encodeURIComponent(oauthToken)}`);
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
    smartLoader.classList.add("hidden");
  }
}

function renderSmartGrid() {
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

function playSmart(pl) {
  const tracks = pl.tracks || [];
  if (tracks.length === 0) {
    toast("В подборке нет треков");
    return;
  }
  // smart queue replaces both wave and any previous queue
  radioSessionId = null;
  queue = tracks;
  queueIndex = 0;
  playTrack(tracks[0]);
  switchTab("tab-wave");
}

smartRefreshBtn.addEventListener("click", () => loadSmart(true));

// ===== Sleep Timer =====
let sleepTimer = null;
let sleepTimerActive = false;

function updateSleepStatus() {
  const el = document.getElementById("sleepStatus");
  if (!el) return;
  if (sleepTimerActive && sleepTimer) {
    const left = Math.max(0, Math.ceil((sleepTimer.expiresAt - Date.now()) / 60000));
    el.textContent = `Музыка остановится через ~${left} мин`;
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

document.querySelectorAll(".sleep-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const minutes = parseInt(btn.getAttribute("data-sleep"), 10);
    if (sleepTimer) { clearTimeout(sleepTimer.t); sleepTimer = null; }
    sleepTimerActive = false;
    if (!minutes) {
      updateSleepStatus();
      toast("Таймер сна отключен");
      return;
    }
    const expiry = Date.now() + minutes * 60000;
    sleepTimer = { expiresAt: expiry, t: setTimeout(() => {
      sleepTimerActive = false;
      audio.pause();
      updateSleepStatus();
      toast("Таймер сна: музыка остановлена 🌙");
    }, minutes * 60000) };
    sleepTimerActive = true;
    updateSleepStatus();
    toast(`Сон через ${minutes} мин`);
  });
});
setInterval(updateSleepStatus, 60000);

// --- Quality Test ---
const qualityTestBtn = document.getElementById("qualityTestBtn");
const qualityTestResult = document.getElementById("qualityTestResult");

qualityTestBtn.addEventListener("click", async () => {
  qualityTestBtn.disabled = true;
  qualityTestResult.classList.remove("hidden");
  qualityTestResult.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Замеряем битрейт...';
  try {
    const params = new URLSearchParams();
    if (oauthToken) params.set("token", oauthToken);
    if (currentTrack) {
      params.set("id", currentTrack.id);
      if (currentTrack.durationMs) params.set("durationMs", currentTrack.durationMs);
    }
    const res = await fetch(`/api/quality-test?${params.toString()}`);
    const data = await res.json();

    if (data.error) {
      qualityTestResult.innerHTML = `<div class="qt-error">${data.error}</div>`;
    } else {
      const rows = (data.results || [])
        .map((r) => {
          if (r.error) {
            return `<div class="qt-row"><div class="qt-q">${r.quality}</div><div class="qt-val qt-bad">✗ ${r.error}</div></div>`;
          }
          const kb = r.kbps ? `${r.kbps} kbps` : "—";
          const mb = r.sizeMb ? `${r.sizeMb} МБ` : "";
          const bad = r.preview ? "qt-bad" : (r.kbps && r.kbps < 100 ? "qt-bad" : "qt-good");
          return `<div class="qt-row">
            <div class="qt-q">${r.quality} <small>${r.codec || ""}</small></div>
            <div class="qt-val ${bad}">${kb} ${mb} ${r.preview ? "ПРЕВЬЮ!" : ""}</div>
          </div>`;
        })
        .join("");
      qualityTestResult.innerHTML = `<div class="qt-title">Трек ${data.track}, длительность ${Math.round(data.durationMs / 1000)} c:</div>${rows}`;
    }
  } catch (e) {
    qualityTestResult.innerHTML = `<div class="qt-error">${e.message}</div>`;
  } finally {
    qualityTestBtn.disabled = false;
  }
});

// Android Lockscreen & Headset controls via MediaSession API
// Референс: googlechrome.github.io/samples/media-session/audio.html + MDN setPositionState.
function msCoverUrl(track, size) {
  // Сервер отдаёт уже подставленный размер (200x200/400x400). Для обложки
  // плеера/уведомления поднимаем до size, если шаблон не подставлен раньше.
  if (!track.coverUri) return FALLBACK_COVER;
  return track.coverUri.replace(/(\d+)x(\d+)/, size);
}

function updatePositionState() {
  if ("mediaSession" in navigator && "setPositionState" in navigator.mediaSession) {
    if (!audio.duration) return; // MDN: duration обязателен, иначе TypeError
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate,
        position: Math.min(audio.currentTime, audio.duration),
      });
    } catch (e) {}
  }
}

function updateMediaSession(track) {
  if ("mediaSession" in navigator) {
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
      play: () => audio.play().catch(() => {}),
      pause: () => audio.pause(),
      stop: () => stopPlayback(),
      nexttrack: () => playNext(),
      previoustrack: () => playPrev(),
      seekbackward: (details) => {
        const skip = details.seekOffset || 10;
        if (audio.duration) {
          audio.currentTime = Math.max(audio.currentTime - skip, 0);
          updatePositionState();
        }
      },
      seekforward: (details) => {
        const skip = details.seekOffset || 10;
        if (audio.duration) {
          audio.currentTime = Math.min(audio.currentTime + skip, audio.duration);
          updatePositionState();
        }
      },
      seekto: (details) => {
        if (details.seekTime == null) return;
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
function stopPlayback() {
  audio.pause();
  audio.currentTime = 0;
  updatePositionState();
}

// ---------- Full Player Screen ----------
function isPlayerOpen() {
  return !playerScreen.classList.contains("hidden");
}

function openPlayer() {
  if (currentTrack) updateFullPlayerUI(currentTrack);
  updateFullProgress();
  playerScreen.classList.remove("hidden");
}

function closePlayer() {
  playerScreen.classList.add("hidden");
}

function updateFullPlayerUI(track) {
  fullTitle.textContent = track.title;
  fullArtist.textContent = track.artists;
  fullCover.onerror = () => { fullCover.onerror = null; fullCover.src = FALLBACK_COVER; };
  fullCover.src = msCoverUrl(track, "600x600");
  const liked = trackIdLiked(track);
  fullLikeIcon.className = liked ? "fa-solid fa-heart" : "fa-regular fa-heart";
  fullLikeBtn.classList.toggle("liked", liked);
  fullTimeTotal.textContent = formatTime(track.durationMs ? track.durationMs / 1000 : (audio.duration || 0));
}

function updateFullProgress() {
  if (!audio.duration) {
    fullProgressFill.style.width = "0%";
    fullProgressKnob.style.left = "0%";
    fullTimeElapsed.textContent = "0:00";
    return;
  }
  const percent = Math.min(audio.currentTime / audio.duration, 1) * 100;
  fullProgressFill.style.width = percent + "%";
  fullProgressKnob.style.left = percent + "%";
  fullTimeElapsed.textContent = formatTime(audio.currentTime);
}

// Перемотка: drag-полоса (pointer events + setPointerCapture).
let scrubbing = false;
fullProgress.addEventListener("pointerdown", (e) => {
  if (!audio.duration) return;
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
  if (audio.duration) {
    audio.currentTime = clientXToSeconds(e.clientX);
    updatePositionState();
  }
});
fullProgress.addEventListener("pointercancel", () => { scrubbing = false; updateFullProgress(); });

function scrubToClientX(clientX) {
  if (!audio.duration) return;
  const seconds = clientXToSeconds(clientX);
  const percent = Math.min(seconds / audio.duration, 1) * 100;
  fullProgressFill.style.width = percent + "%";
  fullProgressKnob.style.left = percent + "%";
  fullTimeElapsed.textContent = formatTime(seconds);
}

function clientXToSeconds(clientX) {
  const rect = fullProgress.getBoundingClientRect();
  const p = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
  return p * audio.duration;
}

// Крупный ряд управления
fullPrevBtn.addEventListener("click", playPrev);
fullNextBtn.addEventListener("click", playNext);
fullPlayBtn.addEventListener("click", togglePlayPause);
fullBack10Btn.addEventListener("click", () => {
  if (audio.duration) {
    audio.currentTime = Math.max(audio.currentTime - 10, 0);
    updatePositionState();
  }
});
fullFwd10Btn.addEventListener("click", () => {
  if (audio.duration) {
    audio.currentTime = Math.min(audio.currentTime + 10, audio.duration);
    updatePositionState();
  }
});
fullStopBtn.addEventListener("click", stopPlayback);
fullCloseBtn.addEventListener("click", closePlayer);
fullLikeBtn.addEventListener("click", () => likeTrack(currentTrack));

// Синхронизация playbackState уведомления с событиями самого <audio>.
audio.addEventListener("play", () => {
  if ("mediaSession" in navigator && "playbackState" in navigator.mediaSession) {
    navigator.mediaSession.playbackState = "playing";
  }
});
audio.addEventListener("pause", () => {
  if ("mediaSession" in navigator && "playbackState" in navigator.mediaSession) {
    navigator.mediaSession.playbackState = "paused";
  }
});
audio.addEventListener("loadedmetadata", () => updatePositionState());
audio.addEventListener("seeked", () => updatePositionState());

// PWA: регистрация service worker (только https или localhost)
if ("serviceWorker" in navigator && (/^https:$/.test(location.protocol) || location.hostname === "localhost")) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
