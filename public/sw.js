// Service Worker: честный кеш оболочки приложения.
// Только GET; /api/* всегда мимо кеша; остальное — network-first с кеш-фолбэком.

const CACHE = "ym-shell-v5";

const PRECACHE = [
  "/",
  "/index.html",
  "/style.css",
  "/manifest.json",
  "/icon.svg",
  "/js/main.js",
  "/js/state.js",
  "/js/dom.js",
  "/js/util.js",
  "/js/api.js",
  "/js/session-memory.js",
  "/js/audio-engine.js",
  "/js/wave.js",
  "/js/likes-core.js",
  "/js/tracks-lists.js",
  "/js/track-sheet.js",
  "/js/player-screen.js",
  "/js/media-session.js",
  "/js/nav.js",
  "/js/auth.js",
  "/js/pwa.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("ym-shell-") && name !== CACHE)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  // API: всегда сеть, без кеша (pass-through)
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request));
    return;
  }

  // Остальное: network-first, фолбэк на кеш, ответы сети складываем в кеш
  event.respondWith(
    fetch(request)
      .then(async (response) => {
        if (response && response.ok) {
          const cache = await caches.open(CACHE);
          cache.put(request, response.clone());
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw new Error("offline and no cached match");
      })
  );
});
