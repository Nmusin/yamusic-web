// DOM elements cache
const byId = (id) => (typeof document !== "undefined" ? document.getElementById(id) : null);
const queryAll = (sel) => (typeof document !== "undefined" && document.querySelectorAll ? document.querySelectorAll(sel) : []);

// Audio element
export const audio = byId("audioElement");

// UI Elements - Wave
export const waveBtn = byId("waveBtn");
export const waveCover = byId("waveCover");
export const wavePlaceholder = byId("wavePlaceholder");
export const waveTrackTitle = byId("waveTrackTitle");
export const waveTrackArtist = byId("waveTrackArtist");
export const waveNextPreview = byId("waveNextPreview");
export const waveNextTitle = byId("waveNextTitle");
export const wavePlayIcon = byId("wavePlayIcon");
export const btnWavePlay = byId("btnWavePlay");
export const btnWavePlayPrev = byId("btnWavePlayPrev");
export const btnDislike = byId("btnDislike");

// UI Elements - MiniPlayer
export const miniPlayer = byId("miniPlayer");
export const miniCover = byId("miniCover");
export const miniTitle = byId("miniTitle");
export const miniArtist = byId("miniArtist");
export const miniPlayBtn = byId("miniPlayBtn");
export const miniPlayIcon = byId("miniPlayIcon");
export const miniNextBtn = byId("miniNextBtn");
export const miniPrevBtn = byId("miniPrevBtn");
export const miniLikeBtn = byId("miniLikeBtn");
export const miniLikeIcon = byId("miniLikeIcon");
export const miniProgressBar = byId("miniProgressBar");
export const miniProgressFill = byId("miniProgressFill");
export const miniTime = byId("miniTime");

// UI Elements - Full Player Screen (AMOLED)
export const playerScreen = byId("playerScreen");
export const fullCloseBtn = byId("fullCloseBtn");
export const fullCover = byId("fullCover");
export const fullTitle = byId("fullTitle");
export const fullArtist = byId("fullArtist");
export const fullLikeBtn = byId("fullLikeBtn");
export const fullLikeIcon = byId("fullLikeIcon");
export const fullTimeElapsed = byId("fullTimeElapsed");
export const fullTimeTotal = byId("fullTimeTotal");
export const fullProgress = byId("fullProgress");
export const fullProgressFill = byId("fullProgressFill");
export const fullProgressKnob = byId("fullProgressKnob");
export const fullPrevBtn = byId("fullPrevBtn");
export const fullBack10Btn = byId("fullBack10Btn");
export const fullFwd10Btn = byId("fullFwd10Btn");
export const fullNextBtn = byId("fullNextBtn");
export const fullPlayBtn = byId("fullPlayBtn");
export const fullPlayIcon = byId("fullPlayIcon");
export const fullStopBtn = byId("fullStopBtn");

// UI Elements - Playlists
export const playlistsScreen = byId("tab-playlists");
export const playlistsGrid = byId("playlistsGrid");
export const playlistsLoader = byId("playlistsLoader");
export const playlistsTitle = byId("playlistsTitle");
export const playlistsBackBtn = byId("playlistsBackBtn");
export const playlistsRefreshBtn = byId("playlistsRefreshBtn");
export const playlistTracks = byId("playlistTracks");

// Like / dislike on Wave and player
export const btnLikeWave = byId("btnLikeWave");
export const waveLikeIcon = byId("waveLikeIcon");

// UI Elements - Search
export const searchInput = byId("searchInput");
export const searchClearBtn = byId("searchClearBtn");
export const searchLoader = byId("searchLoader");
export const searchResults = byId("searchResults");
export const searchCount = byId("searchCount");

// UI Elements - Likes
export const likesScreen = byId("tab-likes");
export const likesResults = byId("likesResults");
export const likesLoader = byId("likesLoader");
export const likesCount = byId("likesCount");
export const likesRefreshBtn = byId("likesRefreshBtn");

// UI Elements - Auth & Profile
export const authBtn = byId("authBtn");
export const authBtnText = byId("authBtnText");
export const guestWarningBanner = byId("guestWarningBanner");
export const bannerLoginBtn = byId("bannerLoginBtn");
export const profileAvatar = byId("profileAvatar");
export const profileAvatarPlaceholder = byId("profileAvatarPlaceholder");
export const profileName = byId("profileName");
export const profileStatus = byId("profileStatus");
export const settingsLoginBtn = byId("settingsLoginBtn");
export const settingsLogoutBtn = byId("settingsLogoutBtn");

// UI Elements - Modal
export const loginModal = byId("loginModal");
export const modalBackdrop = byId("modalBackdrop");
export const closeModalBtn = byId("closeModalBtn");
export const deviceCodeLoading = byId("deviceCodeLoading");
export const deviceCodeContainer = byId("deviceCodeContainer");
export const displayUserCode = byId("displayUserCode");
export const openYaDeviceBtn = byId("openYaDeviceBtn");
export const pollingStatusText = byId("pollingStatusText");
export const checkConfirmedBtn = byId("checkConfirmedBtn");
export const manualTokenInput = byId("manualTokenInput");
export const confirmManualTokenBtn = byId("confirmManualTokenBtn");
export const loginError = byId("loginError");

// Modal Auth Tabs (device / password / token)
export const modalTabBtns = queryAll(".modal-tab-btn");
export const authTabDevice = byId("authTabDevice");
export const authTabPassword = byId("authTabPassword");
export const authTabToken = byId("authTabToken");
export const loginUsername = byId("loginUsername");
export const loginPassword = byId("loginPassword");
export const submitPasswordBtn = byId("submitPasswordBtn");

// Track Actions Sheet
export const trackSheet = byId("trackSheet");
export const sheetBackdrop = byId("sheetBackdrop");
export const sheetCover = byId("sheetCover");
export const sheetTitle = byId("sheetTitle");
export const sheetSub = byId("sheetSub");
export const sheetLikeBtn = byId("sheetLikeBtn");
export const sheetLikeIcon = byId("sheetLikeIcon");
export const sheetNextBtn = byId("sheetNextBtn");
export const sheetPlayBtn = byId("sheetPlayBtn");
export const sheetCloseBtn = byId("sheetCloseBtn");
export const miniDetails = byId("miniDetails");
export const waveEnded = byId("waveEnded");
export const waveEndedBtn = byId("waveEndedBtn");

// Smart Playlists
export const smartGrid = byId("smartGrid");
export const smartLoader = byId("smartLoader");
export const smartRefreshBtn = byId("smartRefreshBtn");

// Quality Test
export const qualityTestBtn = byId("qualityTestBtn");
export const qualityTestResult = byId("qualityTestResult");

// Sleep timer status
export const sleepStatus = byId("sleepStatus");
