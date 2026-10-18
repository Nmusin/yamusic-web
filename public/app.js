// Yandex Music Web App Player
const audio = document.getElementById("audioElement");

// State
let currentTrack = null;
let queue = [];
let queueIndex = 0;
let isPlaying = false;
let quality = localStorage.getItem("ym_quality") || "nq";
let oauthToken = localStorage.getItem("ym_token") || "";

// UI Elements
const waveBtn = document.getElementById("waveBtn");
const waveCover = document.getElementById("waveCover");
const wavePlaceholder = document.getElementById("wavePlaceholder");
const waveTrackTitle = document.getElementById("waveTrackTitle");
const waveTrackArtist = document.getElementById("waveTrackArtist");
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
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));

    btn.classList.add("active");
    const tabId = btn.getAttribute("data-tab");
    document.getElementById(tabId).classList.add("active");
  });
});

// Play Track
function playTrack(track, seekTo = 0) {
  if (!track) return;
  currentTrack = track;

  // Stream URL
  let streamUrl = `/api/stream?id=${track.id}&quality=${quality}`;
  if (oauthToken) streamUrl += `&token=${encodeURIComponent(oauthToken)}`;

  audio.src = streamUrl;
  audio.currentTime = seekTo;
  audio.play().catch((e) => console.log("Playback start error:", e));

  updateTrackUI(track);
  updateMediaSession(track);
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

function playNext() {
  if (queueIndex < queue.length - 1) {
    queueIndex++;
    playTrack(queue[queueIndex]);
  } else {
    // If end of wave queue, fetch more tracks
    startWave();
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

// "Моя Волна" Fetch
async function startWave() {
  waveTrackTitle.textContent = "Загрузка Волны...";
  waveTrackArtist.textContent = "Подбираем музыку...";

  let waveUrl = "/api/wave";
  if (oauthToken) waveUrl += `?token=${encodeURIComponent(oauthToken)}`;

  try {
    const resp = await fetch(waveUrl);
    const data = await resp.json();
    if (data.tracks && data.tracks.length > 0) {
      queue = data.tracks;
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

// Search
let searchTimeout = null;
searchInput.addEventListener("input", (e) => {
  const query = e.target.value.trim();
  if (query.length > 0) {
    searchClearBtn.classList.remove("hidden");
  } else {
    searchClearBtn.classList.add("hidden");
  }

  clearTimeout(searchTimeout);
  if (query.length < 2) {
    searchResults.innerHTML = "";
    return;
  }

  searchLoader.classList.remove("hidden");
  searchTimeout = setTimeout(async () => {
    try {
      let searchUrl = `/api/search?q=${encodeURIComponent(query)}`;
      if (oauthToken) searchUrl += `&token=${encodeURIComponent(oauthToken)}`;
      const res = await fetch(searchUrl);
      const data = await res.json();
      renderSearchResults(data.tracks || []);
    } catch (e) {
      console.error(e);
    } finally {
      searchLoader.classList.add("hidden");
    }
  }, 400);
});

searchClearBtn.addEventListener("click", () => {
  searchInput.value = "";
  searchResults.innerHTML = "";
  searchClearBtn.classList.add("hidden");
});

function renderSearchResults(tracks) {
  searchResults.innerHTML = "";
  if (tracks.length === 0) {
    searchResults.innerHTML = '<p style="text-align:center; color:#777; padding:20px;">Ничего не найдено</p>';
    return;
  }

  tracks.forEach((track, index) => {
    const item = document.createElement("div");
    item.className = "track-item";
    item.innerHTML = `
      <img src="${track.coverUri || 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22/>'}" alt="cover">
      <div class="track-info">
        <div class="track-title">${track.title}</div>
        <div class="track-artist">${track.artists}</div>
      </div>
      <i class="fa-solid fa-play" style="color: #ffcc00; margin-left: 10px;"></i>
    `;
    item.addEventListener("click", () => {
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
