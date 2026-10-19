import { state } from "./state.js";
import { saveToken, clearToken, saveUser, restoreSession } from "./session-memory.js";
import { toast } from "./util.js";
import { switchTab } from "./nav.js";
import { loadLikes, showLikesEmpty } from "./tracks-lists.js";
import { playTrack } from "./audio-engine.js";
import {
  authBtn,
  authBtnText,
  guestWarningBanner,
  bannerLoginBtn,
  profileAvatar,
  profileAvatarPlaceholder,
  profileName,
  profileStatus,
  settingsLoginBtn,
  settingsLogoutBtn,
  loginModal,
  modalBackdrop,
  closeModalBtn,
  deviceCodeLoading,
  deviceCodeContainer,
  displayUserCode,
  openYaDeviceBtn,
  pollingStatusText,
  checkConfirmedBtn,
  manualTokenInput,
  confirmManualTokenBtn,
  loginError,
  modalTabBtns,
  authTabDevice,
  authTabPassword,
  authTabToken,
  loginUsername,
  loginPassword,
  submitPasswordBtn,
  likesScreen,
  likesCount,
  audio,
} from "./dom.js";

// Modal Open / Close & Device Code Flow
export async function openLoginModal() {
  if (!loginModal) return;
  loginModal.classList.remove("hidden");
  if (deviceCodeLoading) deviceCodeLoading.classList.remove("hidden");
  if (deviceCodeContainer) deviceCodeContainer.classList.add("hidden");
  if (loginError) loginError.classList.add("hidden");
  stopPolling();
  switchAuthTab("device");

  try {
    const res = await fetch("/api/auth/device-code");
    const data = await res.json();

    if (data.ok && data.userCode) {
      if (displayUserCode) displayUserCode.textContent = data.userCode;
      if (openYaDeviceBtn) openYaDeviceBtn.href = data.verificationUrl;
      if (deviceCodeLoading) deviceCodeLoading.classList.add("hidden");
      if (deviceCodeContainer) deviceCodeContainer.classList.remove("hidden");

      // Save for the "Я подтвердил вход" button, start background polling
      lastDeviceCode = data.deviceCode;
      startPolling(data.deviceCode, data.interval || 3);
    } else {
      if (deviceCodeLoading) deviceCodeLoading.classList.add("hidden");
      showLoginError(data.error || "Не удалось запросить код входа.");
    }
  } catch (e) {
    if (deviceCodeLoading) deviceCodeLoading.classList.add("hidden");
    showLoginError("Ошибка сети: " + e.message);
  }
}

export function closeLoginModal() {
  if (loginModal) loginModal.classList.add("hidden");
  stopPolling();
}

export function startPolling(deviceCode, intervalSec) {
  stopPolling();
  state.pollInterval = setInterval(async () => {
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

export function stopPolling() {
  if (state.pollInterval) {
    clearInterval(state.pollInterval);
    state.pollInterval = null;
  }
}

export async function onLoginSuccess(token) {
  state.oauthToken = token;
  saveToken(token);

  try {
    const res = await fetch(`/api/account?token=${encodeURIComponent(token)}`);
    const data = await res.json();

    if (data.loggedIn && data.user) {
      state.currentUser = data.user;
      saveUser(data.user);
      updateAuthUI(true);
      closeLoginModal();
      toast(`Добро пожаловать, ${data.user.fullName || data.user.login}!`);
    } else {
      // Token valid at OAuth but account info unavailable — still let user in
      state.currentUser = { login: "profile", fullName: "Профиль" };
      updateAuthUI(true);
      closeLoginModal();
    }
  } catch (e) {
    state.currentUser = { login: "profile", fullName: "Профиль" };
    updateAuthUI(true);
    closeLoginModal();
  }

  // Refresh likes after login
  state.likesLoaded = false;
  if (likesScreen && likesScreen.classList.contains("active")) loadLikes(true);

  // If currently playing 30s preview, restart full track
  if (state.currentTrack && audio) {
    playTrack(state.currentTrack, audio.currentTime);
  }
}

export function showLoginError(msg) {
  if (loginError) {
    loginError.textContent = msg;
    loginError.classList.remove("hidden");
  }
}

// --- Password Tab ---
export async function submitPasswordLogin() {
  if (!loginUsername || !loginPassword) return;
  const username = loginUsername.value.trim();
  const password = loginPassword.value;

  if (!username || !password) {
    showLoginError("Укажите логин и пароль");
    return;
  }

  if (submitPasswordBtn) {
    submitPasswordBtn.disabled = true;
    submitPasswordBtn.textContent = "Входим...";
  }
  if (loginError) loginError.classList.add("hidden");

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
    if (submitPasswordBtn) {
      submitPasswordBtn.disabled = false;
      submitPasswordBtn.textContent = "Войти";
    }
  }
}

// --- Modal Tab Switching (device / password / token) ---
export function switchAuthTab(name) {
  const map = {
    device: [authTabDevice, "auth-device"],
    password: [authTabPassword, "auth-password"],
    token: [authTabToken, "auth-token"],
  };
  if (modalTabBtns) {
    modalTabBtns.forEach((b) => b.classList.toggle("active", b.getAttribute("data-auth") === name));
  }
  Object.entries(map).forEach(([key, [el]]) => {
    if (el) el.classList.toggle("active", key === name);
  });
  if (loginError) loginError.classList.add("hidden");
}

export function updateAuthUI(isLoggedIn) {
  if (isLoggedIn && state.currentUser) {
    if (guestWarningBanner) guestWarningBanner.classList.add("hidden");
    if (authBtnText) authBtnText.textContent = state.currentUser.login || "Профиль";
    if (authBtn) {
      authBtn.style.background = "#2a2a2a";
      authBtn.style.color = "#ffcc00";
    }

    if (profileName) profileName.textContent = state.currentUser.fullName || state.currentUser.login;
    if (profileStatus) profileStatus.textContent = "Аккаунт подключен • Плюс разблокирован";
    if (state.currentUser.avatarUrl) {
      if (profileAvatar) {
        profileAvatar.src = state.currentUser.avatarUrl;
        profileAvatar.classList.remove("hidden");
      }
      if (profileAvatarPlaceholder) profileAvatarPlaceholder.classList.add("hidden");
    } else {
      if (profileAvatar) profileAvatar.classList.add("hidden");
      if (profileAvatarPlaceholder) profileAvatarPlaceholder.classList.remove("hidden");
    }

    if (settingsLoginBtn) settingsLoginBtn.classList.add("hidden");
    if (settingsLogoutBtn) settingsLogoutBtn.classList.remove("hidden");
  } else {
    if (guestWarningBanner) guestWarningBanner.classList.remove("hidden");
    if (authBtnText) authBtnText.textContent = "Войти";
    if (authBtn) {
      authBtn.style.background = "#ffcc00";
      authBtn.style.color = "#000";
    }

    if (profileName) profileName.textContent = "Не авторизован";
    if (profileStatus) profileStatus.textContent = "Без аккаунта треки длятся 30 секунд";
    if (profileAvatar) profileAvatar.classList.add("hidden");
    if (profileAvatarPlaceholder) profileAvatarPlaceholder.classList.remove("hidden");

    if (settingsLoginBtn) settingsLoginBtn.classList.remove("hidden");
    if (settingsLogoutBtn) settingsLogoutBtn.classList.add("hidden");
  }
}

// Initial token check on startup (called from main.js)
export async function initAuth() {
  if (state.oauthToken) {
    // Render cached profile instantly (no waiting for network)
    if (state.cachedUserStr) {
      try {
        state.currentUser = JSON.parse(state.cachedUserStr);
        updateAuthUI(true);
      } catch (e) {}
    }

    // Session memory: молчаливое восстановление очереди и позиции
    restoreSession();

    // Re-validate the token in the background
    fetch(`/api/account?token=${encodeURIComponent(state.oauthToken)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.loggedIn && data.user) {
          state.currentUser = data.user;
          saveUser(data.user);
          updateAuthUI(true);
        } else {
          state.currentUser = null;
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
}

// Wire up event listeners
if (authBtn) {
  authBtn.addEventListener("click", () => {
    if (state.currentUser) {
      switchTab("tab-settings");
    } else {
      openLoginModal();
    }
  });
}
if (bannerLoginBtn) bannerLoginBtn.addEventListener("click", openLoginModal);
if (settingsLoginBtn) settingsLoginBtn.addEventListener("click", openLoginModal);
if (closeModalBtn) closeModalBtn.addEventListener("click", closeLoginModal);
if (modalBackdrop) modalBackdrop.addEventListener("click", closeLoginModal);

// --- Manual Token Tab ---
if (confirmManualTokenBtn) {
  confirmManualTokenBtn.addEventListener("click", () => {
    if (!manualTokenInput) return;
    let token = manualTokenInput.value.trim();
    const match = token.match(/access_token=([^&]+)/);
    if (match) token = match[1];

    if (!token) {
      showLoginError("Введите токен");
      return;
    }
    onLoginSuccess(token);
  });
}
if (manualTokenInput) {
  manualTokenInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && confirmManualTokenBtn) confirmManualTokenBtn.click();
  });
}

// --- Password Tab ---
if (submitPasswordBtn) submitPasswordBtn.addEventListener("click", submitPasswordLogin);
if (loginPassword) {
  loginPassword.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitPasswordLogin();
  });
}

// --- Modal Tab Switching listeners ---
if (modalTabBtns) {
  modalTabBtns.forEach((btn) => {
    btn.addEventListener("click", () => switchAuthTab(btn.getAttribute("data-auth")));
  });
}

// --- "Я подтвердил вход" — force immediate token check ---
let lastDeviceCode = null;
if (checkConfirmedBtn) {
  checkConfirmedBtn.addEventListener("click", async () => {
    if (!lastDeviceCode) return;
    if (pollingStatusText) pollingStatusText.textContent = "Проверяем...";
    try {
      const res = await fetch(`/api/auth/device-token?deviceCode=${encodeURIComponent(lastDeviceCode)}`);
      const data = await res.json();
      if (data.status === "success" && data.accessToken) {
        stopPolling();
        onLoginSuccess(data.accessToken);
      } else if (data.status === "pending") {
        if (pollingStatusText) pollingStatusText.textContent = "Ещё не подтверждено — проверьте ya.ru/device";
      } else {
        stopPolling();
        showLoginError("Ошибка авторизации: " + (data.error || "код истёк"));
      }
    } catch (e) {
      if (pollingStatusText) pollingStatusText.textContent = "Ошибка сети";
    }
  });
}

// Logout
if (settingsLogoutBtn) {
  settingsLogoutBtn.addEventListener("click", () => {
    if (confirm("Вы действительно хотите выйти из аккаунта?")) {
      state.oauthToken = "";
      state.currentUser = null;
      clearToken();
      updateAuthUI(false);
      // Reset likes tab to the logged-out state
      state.likesData = [];
      state.likesLoaded = false;
      showLikesEmpty("Войдите в аккаунт, чтобы увидеть лайкнутые треки");
      if (likesCount) likesCount.textContent = "";
    }
  });
}
