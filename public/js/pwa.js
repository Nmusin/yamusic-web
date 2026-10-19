// PWA: регистрация service worker (только https или localhost)
export function registerSW() {
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator && (/^https:$/.test(location.protocol) || location.hostname === "localhost")) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

if (typeof navigator !== "undefined" && "serviceWorker" in navigator && (/^https:$/.test(location.protocol) || location.hostname === "localhost")) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
