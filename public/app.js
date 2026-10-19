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

// --- Token persistence: localStorage + cookie fallback ---
// (iOS Safari can wipe localStorage, the cookie survives)
function setCookie(name, value, days) {
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${days * 86400}; SameSite=Lax`;
}
function readCookie(name) {
  const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}
function getToken() {
  return localStorage.getItem("ym_token") || readCookie("ym_token") || "";
}
function saveToken(token) {
  try { localStorage.setItem("ym_token", token); } catch (e) {}
  setCookie("ym_token", token, 365); // keep for a year
}
function clearToken() {
  try { localStorage.removeItem("ym_token"); } catch (e) {}
  setCookie("ym_token", "", 0);
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
const btnWaveNext = document.getElementById("btnWaveNext");
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
const miniProgressBar = document.getElementById("miniProgressBar");
const miniProgressFill = document.getElementById("miniProgressFill");
const miniTime = document.getElementById("miniTime");

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
    // Load likes lazily on first open
    if (tabId === "tab-likes") loadLikes();
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
  miniCover.src = track.coverUri || "";

  // Highlight currently playing track in the search list
  document.querySelectorAll(".track-item.playing").forEach((el) => el.classList.remove("playing"));
  const activeItem = document.querySelector(`.track-item[data-track-id="${CSS.escape(String(track.id))}"]`);
  if (activeItem) {
    activeItem.classList.add("playing");
    const icon = activeItem.querySelector(".track-play-btn i");
    if (icon) icon.className = "fa-solid fa-pause";
  }
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
  } else {
    waveBtn.classList.remove("playing");
    wavePlayIcon.className = "fa-solid fa-play";
    miniPlayIcon.className = "fa-solid fa-play";
  }
}

// Audio Element Events
audio.addEventListener("play", () => { consecutiveErrors = 0; setPlayState(true); });
audio.addEventListener("pause", () => setPlayState(false));
audio.addEventListener("loadedmetadata", () => showTime());
audio.addEventListener("timeupdate", () => {
  if (audio.duration) {
    const percent = (audio.currentTime / audio.duration) * 100;
    miniProgressFill.style.width = percent + "%";
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
  } else if (audio.currentTime > 3) {
    // Restart current track like real players do
    audio.currentTime = 0;
  }
}

async function playNext() {
  if (radioSessionId && currentTrack) sendRotorFeedback("skip");
  if (queueIndex < queue.length - 1) {
    queueIndex++;
    playTrack(queue[queueIndex]);
  } else {
    if (radioSessionId) {
      waveTrackTitle.textContent = "Загрузка новых треков...";
      waveTrackArtist.textContent = "Волна продолжается";
      await fetchMoreWaveTracks();
      if (queueIndex < queue.length - 1) {
        queueIndex++;
        playTrack(queue[queueIndex]);
      } else {
        startWave();
      }
    } else {
      startWave();
    }
  }
}

btnWavePlay.addEventListener("click", togglePlayPause);
waveBtn.addEventListener("click", togglePlayPause);
miniPlayBtn.addEventListener("click", togglePlayPause);
btnWaveNext.addEventListener("click", playNext);
miniNextBtn.addEventListener("click", playNext);
btnWavePlayPrev.addEventListener("click", playPrev);
miniPrevBtn.addEventListener("click", playPrev);
btnDislike.addEventListener("click", playNext);

miniProgressBar.addEventListener("click", (e) => {
  if (!audio.duration) return;
  const rect = miniProgressBar.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const percent = clickX / rect.width;
  audio.currentTime = percent * audio.duration;
});

// "Моя Волна" Continuous Fetch (NO LOOPS / REPEATS)
async function startWave() {
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
    try {
      let searchUrl = `/api/search?q=${encodeURIComponent(q)}`;
      if (oauthToken) searchUrl += `&token=${encodeURIComponent(oauthToken)}`;
      const res = await fetch(searchUrl);
      const data = await res.json();
      renderSearchResults(data.tracks || []);
    } catch (e) {
      searchResults.innerHTML = `<p style="text-align:center; color:#ff5252; padding:20px;">Ошибка поиска: ${e.message}</p>`;
    } finally {
      searchLoader.classList.add("hidden");
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
      radioSessionId = null;
      queue = tracks;
      queueIndex = index;
      playTrack(track);
      if (container === searchResults) switchTab("tab-search");
    });
    container.appendChild(item);

    // Mark the track that is already playing in this session
    if (currentTrack && String(currentTrack.id) === String(track.id)) item.classList.add("playing");
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
  if (likesLoaded && !force) return;

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
function updateMediaSession(track) {
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artists,
      album: track.album || "Яндекс Музыка",
      artwork: track.coverUri ? [{ src: track.coverUri, sizes: "400x400", type: "image/jpeg" }] : [],
    });

    navigator.mediaSession.setActionHandler("play", () => audio.play());
    navigator.mediaSession.setActionHandler("pause", () => audio.pause());
    navigator.mediaSession.setActionHandler("nexttrack", () => playNext());
    navigator.mediaSession.setActionHandler("previoustrack", () => playPrev());
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (details.seekTime) audio.currentTime = details.seekTime;
    });
  }
}
