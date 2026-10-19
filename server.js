const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = process.env.PORT || 3000;

// --- Shared helpers (extracted in de-god refactor) ---
const { resolveToken, getAccountInfo } = require("./lib/auth");
const { yandexRequest, httpsPostForm } = require("./lib/yandex");
const { yandexCached, invalidateApiCache } = require("./lib/cache");

// --- API: Payload parsing (JSON, 1MB cap) ---
function parseBody(req, limit = 1024 * 1024) {
  return new Promise((resolve) => {
    let body = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      if ((body += chunk).length > limit) {
        tooLarge = true;
        req.destroy(); // отрубаем соединение — тело слишком большое
        return;
      }
    });
    req.on("error", () => resolve({}));
    req.on("end", () => {
      if (tooLarge) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        resolve({});
      }
    });
  });
}

// Пакетное разрешение полных треков по id: у API есть лимит на размер запроса,
// поэтому длинные списки (большие библиотеки лайков) дробим на чанки
const TRACKS_BATCH_SIZE = 300;
async function fetchTracksByIds(ids, token) {
  const items = [];
  for (let i = 0; i < ids.length; i += TRACKS_BATCH_SIZE) {
    const chunk = ids.slice(i, i + TRACKS_BATCH_SIZE);
    const resp = await yandexCached(
      `https://api.music.yandex.net/tracks?track-ids=${encodeURIComponent(chunk.join(","))}`,
      token, 10 * 60 * 1000
    );
    const arr = Array.isArray(resp.data) ? resp.data : resp.data?.result;
    if (Array.isArray(arr)) items.push(...arr);
  }
  return items;
}

// --- Route modules ---
const authRoutes = require("./routes/auth");
const waveRoutes = require("./routes/wave");
const likesRoutes = require("./routes/likes");
const musicRoutes = require("./routes/music");
const streamRoutes = require("./routes/stream");
const accountRoutes = require("./routes/account");

// Canonical context: everything a route handler may need (invariants from spec D2)
const ctx = {
  resolveToken,
  parseBody,
  fetchTracksByIds,
  yandexRequest,
  httpsPostForm,
  yandexCached,
  invalidateApiCache,
  getAccountInfo,
};

// --- Dispatch map: pathname → handler (method-sensitive entries noted inline) ---
const ROUTES = {
  "/api/auth/device-code": authRoutes.deviceCodeHandler,
  "/api/auth/device-token": authRoutes.deviceTokenHandler, // GET (poll)
  "/api/auth/password": (req, res) =>
    req.method === "POST" ? authRoutes.authPasswordHandler(req, res, ctx) : staticFallback(req, res),
  "/api/wave": (req, res) => waveRoutes.waveHandler(req, res, ctx),
  "/api/rotor/feedback": (req, res) =>
    req.method === "POST" ? waveRoutes.rotorFeedbackHandler(req, res, ctx) : staticFallback(req, res),
  "/api/likes": (req, res) => likesRoutes.likesHandler(req, res, ctx),
  "/api/like": (req, res) =>
    req.method === "POST" ? likesRoutes.likeHandler(req, res, ctx) : staticFallback(req, res),
  "/api/like-status": (req, res) => likesRoutes.likeStatusHandler(req, res, ctx),
  "/api/search": (req, res) => musicRoutes.musicSearchHandler(req, res, ctx),
  "/api/playlists": (req, res) => musicRoutes.playlistsHandler(req, res, ctx),
  "/api/playlist-tracks": (req, res) => musicRoutes.playlistTracksHandler(req, res, ctx),
  "/api/smart-playlists": (req, res) => musicRoutes.smartPlaylistsHandler(req, res, ctx),
  "/api/quality-test": (req, res) => streamRoutes.qualityTestHandler(req, res, ctx),
  "/api/stream": (req, res) => streamRoutes.streamHandler(req, res, ctx),
  "/api/account": (req, res) => accountRoutes.accountHandler(req, res, ctx),
  "/api/play-audio": (req, res) =>
    req.method === "POST" ? accountRoutes.playAudioHandler(req, res, ctx) : staticFallback(req, res),
  "/api/cache-stats": (req, res) => accountRoutes.cacheStatsHandler(req, res),
};

// POST-only routes called with the wrong method fall through to static (старое поведение:
// инлайн-if'ы не совпали по method → цепочка проваливалась в статику/404)
function staticFallback(req, res) {
  serveStatic(req, res);
}

function serveStatic(req, res) {
  const pathname = url.parse(req.url, true).pathname;
  // --- Static Files --- (только файлы внутри public, никакого path traversal)
  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname === "/" ? "index.html" : pathname);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("400 Bad Request");
    return;
  }
  const publicRoot = path.join(__dirname, "public");
  const filePath = path.normalize(path.join(publicRoot, relativePath));
  if (!filePath.startsWith(publicRoot + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("403 Forbidden");
    return;
  }
  const extname = path.extname(filePath);
  const mimeTypes = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpg",
    ".svg": "image/svg+xml",
  };

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === "ENOENT") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("404 Not Found");
      } else {
        res.writeHead(500);
        res.end("Server Error: " + error.code);
      }
    } else {
      res.writeHead(200, { "Content-Type": mimeTypes[extname] || "text/plain" });
      res.end(content, "utf-8");
    }
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Remember nothing server-side: токен всегда приходит с запросом

  console.log(`[REQ] ${req.method} ${pathname}`);

  const handler = ROUTES[pathname];
  if (handler) {
    await handler(req, res);
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🎵 Yandex Music Web Wrapper running at http://0.0.0.0:${PORT}`);
});
