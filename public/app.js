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

let quality = localStorage.getItem("ym_quality") || "nq";
let oauthToken = localStorage.getItem("ym_token") || "";

// UI Elements
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
const btnDislike = document.getElementById("btnDislike");

const miniPlayer = document.getElementById("miniPlayer");
const miniCover = document.getElementById("miniCover");
const miniTitle = document.getElementById("miniTitle");
const miniArtist = document.getElementById("miniArtist");
const miniPlayBtn = document.getElementById("miniPlayBtn");
const miniPlayIcon = document.getElementById("miniPlayIcon");
const miniNextBtn = document.getElementById("miniNextBtn");
const miniProgressBar = document.getElementById("miniProgressBar");
const miniProgressFill = document.getElementById("miniProgressFill");

const searchInput = document.getElementById("searchInput");
const searchClearBtn = document.getElementById("searchClearBtn");
const searchLoader = document.getElementById("searchLoader");
const searchResults = document.getElementById("searchResults");
const searchCount = document.getElementById("searchCount");
const headerSearchBtn = document.getElementById("headerSearchBtn");

const tokenInput = document.getElementById("tokenInput");
const saveTokenBtn = document.getElementById("saveTokenBtn");

// Initialize Settings
tokenInput.value = oauthToken;
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

saveTokenBtn.addEventListener("click", () => {
  oauthToken = tokenInput.value.trim();
  localStorage.setItem("ym_token", oauthToken);
  alert("Токен сохранен!");
});

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
    switchTab(btn.getAttribute("data-tab"));
  });
});

headerSearchBtn.addEventListener("click", () => {
  switchTab("tab-search");
  searchInput.focus();
});

// Play Track
function playTrack(track, seekTo = 0) {
  if (!track) return;
  currentTrack = track;
  playedTrackIds.add(String(track.id));

  // Stream URL
  let streamUrl = `/api/stream?id=${encodeURIComponent(track.id)}&quality=${quality}`;
  if (oauthToken) streamUrl += `&token=${encodeURIComponent(oauthToken)}`;

  audio.src = streamUrl;
  audio.currentTime = seekTo;
  audio.play().catch((e) => console.log("Playback error:", e));

  updateTrackUI(track);
  updateMediaSession(track);
  updateNextPreview();

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
audio.addEventListener("play", () => setPlayState(true));
audio.addEventListener("pause", () => setPlayState(false));
audio.addEventListener("timeupdate", () => {
  if (audio.duration) {
    const percent = (audio.currentTime / audio.duration) * 100;
    miniProgressFill.style.width = percent + "%";
  }
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

async function playNext() {
  // If we have next track in queue
  if (queueIndex < queue.length - 1) {
    queueIndex++;
    playTrack(queue[queueIndex]);
  } else {
    // End of current queue
    if (radioSessionId) {
      waveTrackTitle.textContent = "Загрузка новых треков...";
      waveTrackArtist.textContent = "Волна продолжается";
      await fetchMoreWaveTracks();
      if (queueIndex < queue.length - 1) {
        queueIndex++;
        playTrack(queue[queueIndex]);
      } else {
        // Fallback: start new wave
        startWave();
      }
    } else {
      // In search or playlist mode, if finished, continue into My Wave!
      startWave();
    }
  }
}

btnWavePlay.addEventListener("click", togglePlayPause);
waveBtn.addEventListener("click", togglePlayPause);
miniPlayBtn.addEventListener("click", togglePlayPause);
btnWaveNext.addEventListener("click", playNext);
miniNextBtn.addEventListener("click", playNext);
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
  waveTrackArtist.textContent = "Подбираем персональные треки...";
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
      // Filter any already played in this browser session
      const freshTracks = data.tracks.filter((t) => !playedTrackIds.has(String(t.id)));
      queue = freshTracks.length > 0 ? freshTracks : data.tracks;
      queueIndex = 0;
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

      // Add only unplayed tracks
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

function renderSearchResults(tracks) {
  searchResults.innerHTML = "";
  searchCount.textContent = tracks.length > 0 ? `${tracks.length} найдено` : "";

  if (tracks.length === 0) {
    searchResults.innerHTML = '<p style="text-align:center; color:#777; padding:40px;">Ничего не найдено</p>';
    return;
  }

  tracks.forEach((track, index) => {
    const item = document.createElement("div");
    item.className = "track-item";
    const duration = track.durationMs
      ? `${Math.floor(track.durationMs / 60000)}:${String(Math.floor((track.durationMs % 60000) / 1000)).padStart(2, "0")}`
      : "";

    item.innerHTML = `
      <img src="${track.coverUri || 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22/>'}" alt="cover">
      <div class="track-info">
        <div class="track-title">${track.title}</div>
        <div class="track-artist">${track.artists} ${track.album ? '• ' + track.album : ''}</div>
      </div>
      ${duration ? `<span style="font-size:12px; color:#666; margin-right:8px;">${duration}</span>` : ''}
      <button class="track-play-btn" title="Слушать">
        <i class="fa-solid fa-play"></i>
      </button>
    `;
    item.addEventListener("click", () => {
      radioSessionId = null; // Exit wave session to play search playlist
      queue = tracks;
      queueIndex = index;
      playTrack(track);
    });
    searchResults.appendChild(item);
  });
}

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
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (details.seekTime) audio.currentTime = details.seekTime;
    });
  }
}
