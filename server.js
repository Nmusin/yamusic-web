const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const url = require("url");
const stream = require("stream");

const PORT = process.env.PORT || 3000;
const SECRET_KEY = "kzqU4XhfCaY6B6JTHODeq5";
const CLIENT_HEADER = "YandexMusicDesktopAppWindows/5.46.2";


// --- .env loader (KEY=VALUE lines; YM_TOKEN used as default account token) ---
const ENV_FILE = path.join(__dirname, ".env");
try {
  if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
} catch (e) {}

let DEFAULT_TOKEN = process.env.YM_TOKEN || "";
// Токен берётся только из запроса или из .env — без глобального
// "последнего виденного" (иначе аккаунты разных клиентов смешиваются)
function resolveToken(qt) {
  return qt || DEFAULT_TOKEN || null;
}

// Official Yandex Music OAuth credentials (from MarshalX/yandex-music-token)
const OAUTH_CLIENT_ID = "23cabbbdc6cd418abb4b39c32c41195d";
const OAUTH_CLIENT_SECRET = "53bc75238f0c4d08a118e51fe9203300";

function generateSign(trackId, quality, codecs, transports, ts) {
  const data = `${ts}${trackId}${quality}${codecs.join("")}${transports}`;
  const hmac = crypto.createHmac("sha256", SECRET_KEY).update(data).digest("base64");
  return hmac.endsWith("=") ? hmac.slice(0, -1) : hmac;
}

function yandexRequest(targetUrl, token, method = "GET", postData = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "X-Yandex-Music-Client": CLIENT_HEADER,
      "X-Yandex-Music-Frontend": "new",
      "X-Yandex-Music-Without-Invocation-Info": "1",
    };
    if (token) {
      headers["Authorization"] = token.startsWith("OAuth ") ? token : `OAuth ${token}`;
    }
    if (postData) {
      headers["Content-Type"] = "application/json";
    }

    // Yandex DNS может отдавать только IPv6-адрес, а исходящий IPv6 часто недоступен
    // (TTL у IPv6-ответа есть, пакетов нет) — форсируем IPv4 везде, где ходим наружу
    const req = https.request(parsed, { method, headers, family: 4 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsedJson = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsedJson });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error("Yandex API timeout")));
    req.on("error", reject);
    if (postData) {
      req.write(JSON.stringify(postData));
    }
    req.end();
  });
}

function httpsPostForm(targetUrl, params, token = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const body = new URLSearchParams(params).toString();
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
      "User-Agent": "YandexMusic/5.46.2",
    };
    if (token) {
      headers["Authorization"] = token.startsWith("OAuth ") ? token : `OAuth ${token}`;
    }

    const req = https.request(parsed, { method: "POST", headers, family: 4 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsedJson = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsedJson });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error("OAuth timeout")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

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

// --- Generic in-memory cache for Yandex API GET responses ---
// Entries are keyed by (token hash | request URL) so different accounts never mix.
// TTLs are per call; caches are invalidated explicitly when data changes (likes).
const API_CACHE_LIMIT = 400;
const apiCache = new Map(); // key -> { resp: {status, data}, ts, hits }
const ACCOUNT_CACHE_TTL = 10 * 60 * 1000; // account/about rarely changes
const accInfoCache = new Map(); // tokenHash -> { info, ts }

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 12);
}

async function yandexCached(url, token, ttlMs) {
  const key = `${tokenHash(token)}|${url}`;
  const now = Date.now();
  const hit = apiCache.get(key);
  if (hit && now - hit.ts < ttlMs) {
    hit.hits++;
    return { status: hit.resp.status, data: hit.resp.data, cached: true };
  }
  const resp = await yandexRequest(url, token);
  if (resp.status === 200 && resp.data) {
    apiCache.set(key, { resp: { status: resp.status, data: resp.data }, ts: now, hits: 0 });
    if (apiCache.size > API_CACHE_LIMIT) {
      const oldest = apiCache.keys().next().value;
      apiCache.delete(oldest);
    }
  }
  return resp;
}

// Drop cached URLs containing `fragment` (e.g. "/likes/tracks" after a successful like)
function invalidateApiCache(fragment) {
  let n = 0;
  for (const k of Array.from(apiCache.keys())) {
    if (k.includes(fragment)) {
      apiCache.delete(k);
      n++;
    }
  }
  return n;
}

function cacheStats() {
  let hits = 0;
  for (const v of apiCache.values()) hits += v.hits || 0;
  return { entries: apiCache.size, totalHits: hits, limit: API_CACHE_LIMIT };
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

// Resolve Yandex account info from a token. Tries /account/about, then /account/status.
// Handles both nested ({result:{account:{uid}}}) and flat ({result:{uid}}) shapes.
async function getAccountInfo(token) {
  // Cached per token: every UI request normally resolves the account; /account/about is slow.
  const tHash = tokenHash(token);
  const cachedInfo = accInfoCache.get(tHash);
  if (cachedInfo && Date.now() - cachedInfo.ts < ACCOUNT_CACHE_TTL) {
    return cachedInfo.info;
  }
  const endpoints = [
    "https://api.music.yandex.net/account/about",
    "https://api.music.yandex.net/account/status",
  ];
  for (const ep of endpoints) {
    const resp = await yandexRequest(ep, token);
    const r = resp.data?.result || resp.data || {};
    const account = r.account || r;
    const uid = account.uid || r.uid;
    if (resp.status === 200 && uid) {
      const avatarRaw = r.avatarUrl || account.avatarUrl;
      const hasPlus = !!(r.plus?.has_plus || account.plus?.has_plus);
      const result = {
        loggedIn: true,
        user: {
          uid,
          login: account.login || r.login,
          fullName: account.fullName || account.displayName || account.login || r.fullName || r.login,
          avatarUrl: avatarRaw ? `https://avatars.yandex.net/get-yapic/${avatarRaw}/islands-200` : null,
          hasPlus, // real subscription status
        },
      };
      accInfoCache.set(tHash, { info: result, ts: Date.now() });
      return result;
    }
    console.log(`[AUTH] ${ep} responded ${resp.status}, keys:`, JSON.stringify(Object.keys(r)).slice(0, 200));
  }
  return { loggedIn: false, error: "Invalid token" };
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  // Remember nothing server-side: токен всегда приходит с запросом

  console.log(`[REQ] ${req.method} ${pathname}`);

  // --- API: Request Device Code for One-Click Login ---
  if (pathname === "/api/auth/device-code") {
    try {
      const deviceId = "ym-mod-" + Date.now();
      const result = await httpsPostForm("https://oauth.yandex.ru/device/code", {
        client_id: OAUTH_CLIENT_ID,
        device_id: deviceId,
        device_name: "Yandex Music Web Mod",
      });

      console.log(`[AUTH] Device code created: ${result.data?.user_code}`);

      if (result.status === 200 && result.data?.user_code) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            userCode: result.data.user_code,
            deviceCode: result.data.device_code,
            verificationUrl: `https://ya.ru/device?user_code=${result.data.user_code}`,
            interval: result.data.interval || 3,
            expiresIn: result.data.expires_in || 300,
          })
        );
      } else {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: result.data?.error_description || "Error requesting device code" }));
      }
    } catch (e) {
      console.error("[AUTH] Error:", e);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // --- API: Poll for Token Confirmation ---
  if (pathname === "/api/auth/device-token") {
    const deviceCode = query.deviceCode;
    if (!deviceCode) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing deviceCode" }));
      return;
    }

    try {
      const result = await httpsPostForm("https://oauth.yandex.ru/token", {
        grant_type: "device_code",
        code: deviceCode,
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
      });

      if (result.status === 200 && result.data?.access_token) {
        console.log("[AUTH] Device token granted successfully!");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", accessToken: result.data.access_token }));
      } else if (
        result.data?.error === "authorization_pending" ||
        result.data?.error === "slow_down"
      ) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "pending" }));
      } else {
        console.log("[AUTH] Device token poll status:", result.data);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", error: result.data?.error_description || result.data?.error }));
      }
    } catch (e) {
      console.error("[AUTH] Poll error:", e);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error", error: e.message }));
    }
    return;
  }

  // --- API: Login with Username / Password ---
  if (pathname === "/api/auth/password" && req.method === "POST") {
    const body = await parseBody(req);
    const { username, password } = body;

    if (!username || !password) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Укажите логин и пароль" }));
      return;
    }

    try {
      const result = await httpsPostForm("https://oauth.yandex.ru/token", {
        grant_type: "password",
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
        username,
        password,
      });

      if (result.status === 200 && result.data?.access_token) {
        console.log(`[AUTH] User ${username} logged in via password!`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, accessToken: result.data.access_token }));
      } else {
        const desc = result.data?.error_description || result.data?.error || "Ошибка авторизации";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: desc }));
      }
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // --- API: cache diagnostics ---
  if (pathname === "/api/cache-stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(cacheStats()));
    return;
  }

  // --- API: Account Status / Login Verification ---
  if (pathname === "/api/account") {
    const token = resolveToken(query.token || req.headers["authorization"]);
    if (!token) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ loggedIn: false }));
      return;
    }

    try {
      const info = await getAccountInfo(token);
      if (info.loggedIn) {
        console.log(`[AUTH] Account verified: ${info.user.login} (uid ${info.user.uid})`);
      } else {
        console.log("[AUTH] Token could not be verified for account info");
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(info));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ loggedIn: false, error: e.message }));
    }
    return;
  }

  // --- API: Search ---
  if (pathname === "/api/search") {
    const text = query.q || "";
    const token = resolveToken(query.token);
    if (!text.trim()) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tracks: [] }));
      return;
    }

    try {
      const searchUrl = `https://api.music.yandex.net/search?text=${encodeURIComponent(text)}&type=track&page=0`;
      const result = await yandexCached(searchUrl, token, 5 * 60 * 1000);
      const items = result.data?.tracks?.results || result.data?.result?.tracks?.items || [];
      const cleanTracks = items.map((t) => ({
        id: String(t.id),
        title: t.title,
        artists: t.artists ? t.artists.map((a) => a.name).join(", ") : "Unknown",
        album: t.albums && t.albums[0] ? t.albums[0].title : null,
        albumId: t.albums && t.albums[0] ? String(t.albums[0].id) : null,
        coverUri: t.coverUri
          ? "https://" + t.coverUri.replace("%%", "200x200")
          : t.ogImage
          ? "https://" + t.ogImage.replace("%%", "200x200")
          : null,
        durationMs: t.durationMs || 0,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tracks: cleanTracks }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // --- API: User Liked Tracks ---
  if (pathname === "/api/likes") {
    const token = resolveToken(query.token);
    if (!token) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tracks: [], guest: true }));
      return;
    }

    try {
      // 1. Get user info (about → status fallback, nested/flat shapes)
      const accInfo = await getAccountInfo(token);
      if (!accInfo.loggedIn) {
        console.log("[LIKES] Cannot resolve account uid for likes");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ tracks: [], guest: true }));
        return;
      }
      const uid = accInfo.user.uid;

      // 2. Get liked track IDs (short TTL: user can like something at any moment)
      const likes = await yandexCached(
        `https://api.music.yandex.net/users/${uid}/likes/tracks`,
        token, 60 * 1000
      );
      const rawLibrary = likes.data?.result ?? likes.data ?? {};
      const likesList = rawLibrary?.library?.tracks || rawLibrary?.tracks || [];
      const ids = likesList.map((t) => String(t.id));
      if (ids.length === 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ tracks: [] }));
        return;
      }

      // 3. Fetch full track info in batched requests (track metadata is stable — long TTL)
      const items = await fetchTracksByIds(ids, token);

      // Preserve the order the user liked them (newest first)
      const byId = new Map(items.map((t) => [String(t.id), t]));
      const cleanTracks = ids
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((t) => ({
          id: String(t.id),
          title: t.title,
          artists: t.artists ? t.artists.map((a) => a.name).join(", ") : "Unknown",
          album: t.albums && t.albums[0] ? t.albums[0].title : null,
          coverUri: t.coverUri
            ? "https://" + t.coverUri.replace("%%", "200x200")
            : t.ogImage
            ? "https://" + t.ogImage.replace("%%", "200x200")
            : null,
          albumId: t.albums && t.albums[0] ? String(t.albums[0].id) : null,
          durationMs: t.durationMs || 0,
        }));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tracks: cleanTracks }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // --- API: My Wave (Моя Волна) with continuous session progression ---
  if (pathname === "/api/wave") {
    const token = resolveToken(query.token);
    const sessionId = query.sessionId || null;

    let targetUrl;
    let method = "GET";
    let body = null;

    if (sessionId) {
      targetUrl = `https://api.music.yandex.net/rotor/session/${encodeURIComponent(sessionId)}/tracks`;
      method = "POST";
      body = {};
    } else {
      targetUrl = "https://api.music.yandex.net/rotor/station/user:onyourwave/tracks";
      method = "GET";
    }

    try {
      const result = await yandexRequest(targetUrl, token, method, body);
      const radioSessionId = result.data?.radioSessionId || sessionId;
      const sequence = result.data?.sequence || result.data?.result?.sequence || [];

      // Filter out promo ads: check by title fragment and availability
      const cleanTracks = sequence
        .filter((item) => {
          if (!item.track) return false;
          if (item.track.available === false) return false;
          if (/промокод/i.test(item.track.title || "")) return false;
          return true;
        })
        .map((item) => {
          const t = item.track;
          return {
            id: String(t.id),
            title: t.title,
            artists: t.artists ? t.artists.map((a) => a.name).join(", ") : "Unknown",
            album: t.albums && t.albums[0] ? t.albums[0].title : null,
            coverUri: t.coverUri
              ? "https://" + t.coverUri.replace("%%", "400x400")
              : t.ogImage
              ? "https://" + t.ogImage.replace("%%", "400x400")
              : null,
            albumId: t.albums && t.albums[0] ? String(t.albums[0].id) : null,
            durationMs: t.durationMs || 0,
          };
        });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tracks: cleanTracks, radioSessionId }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // --- API: Rotor Feedback (skip / trackStarted / radioStarted) — keeps the Wave flowing ---
  if (pathname === "/api/rotor/feedback" && req.method === "POST") {
    const token = resolveToken(query.token);
    if (!token) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, guest: true }));
      return;
    }

    const body = await parseBody(req);
    const stationId = body.station || "user:onyourwave";
    const feedback = {
      type: body.type || "trackStarted",
      timestamp: new Date().toISOString(),
    };
    if (body.trackId) feedback.trackId = String(body.trackId);
    if (body.batchId) feedback.batchId = String(body.batchId);
    if (body.from) feedback.from = String(body.from);

    try {
      const result = await yandexRequest(
        `https://api.music.yandex.net/rotor/station/${encodeURIComponent(stationId)}/feedback`,
        token,
        "POST",
        feedback
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: result.status === 200 }));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

// HEAD request to storage — to learn the real file size
function httpsHead(targetUrl) {
  return new Promise((resolve, reject) => {
    const req = https.request(targetUrl, { method: "HEAD", family: 4 }, (res) => {
      res.resume();
      clearTimeout(t);
      resolve({
        status: res.statusCode,
        contentLength: parseInt(res.headers["content-length"] || "0", 10),
        contentType: res.headers["content-type"] || "",
      });
    });
    const t = setTimeout(() => req.destroy(new Error("HEAD timeout")), 15000);
    req.on("error", (e) => { clearTimeout(t); reject(e); });
    req.end();
  });
}

// --- Get-file-info with in-memory cache (signed URLs live for ~20 min) ---
const downloadInfoCache = new Map(); // `${quality}:${trackId}` -> {d, ts}
const FILE_INFO_TTL_MS = 20 * 60 * 1000;

async function fetchDownloadInfo(token, trackId, quality) {
  const cacheKey = `${quality}:${trackId}`;
  const hit = downloadInfoCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < FILE_INFO_TTL_MS) {
    return { downloadInfo: hit.d, cached: true };
  }

  const ts = Math.floor(Date.now() / 1000);
  const codecs = ["flac", "aac", "he-aac", "mp3", "flac-mp4", "aac-mp4", "he-aac-mp4"];
  const transports = "encraw";
  const sign = generateSign(trackId, quality, codecs, transports, ts);
  const infoUrl = `https://api.music.yandex.net/get-file-info?ts=${ts}&trackId=${trackId}&quality=${quality}&codecs=${encodeURIComponent(codecs.join(","))}&transports=${transports}&sign=${encodeURIComponent(sign)}`;
  const info = await yandexRequest(infoUrl, token);
  const d = info.data?.result?.downloadInfo || info.data?.downloadInfo;
  if (d && d.urls && d.urls[0]) {
    downloadInfoCache.set(cacheKey, { d, ts: Date.now() });
    if (downloadInfoCache.size > 200) {
      const firstKey = downloadInfoCache.keys().next().value;
      downloadInfoCache.delete(firstKey);
    }
  }
  return { downloadInfo: d, cached: false };
}

// AES-128-CTR decipher whose keystream starts at a byte offset (for HTTP Range seeks).
// Returns a single Transform when no offset, or {transform, readable} pair otherwise.
function ctrDecipherAt(keyBuffer, byteOffset) {
  if (!byteOffset || byteOffset < 0) byteOffset = 0;
  const iv = Buffer.alloc(16, 0);
  const blockIndex = Math.floor(byteOffset / 16);
  let v = blockIndex;
  for (let i = 15; i >= 0 && v > 0; i--) {
    iv[i] = v % 256;
    v = Math.floor(v / 256);
  }
  const decipher = crypto.createDecipheriv("aes-128-ctr", keyBuffer, iv);

  const offsetInBlock = byteOffset % 16;
  if (!offsetInBlock) return decipher; // plain Transform

  // Skip the first `offsetInBlock` plaintext bytes (only that many from the initial keystream block)
  let skipBytes = offsetInBlock;
  const skipper = new stream.Transform({
    transform(chunk, enc, cb) {
      if (skipBytes > 0) {
        const cut = Math.min(skipBytes, chunk.length);
        chunk = chunk.slice(cut);
        skipBytes -= cut;
      }
      if (chunk.length) this.push(chunk);
      cb();
    },
  });
  decipher.pipe(skipper);
  return { transform: decipher, readable: skipper };
}

// --- API: Quality Test — probes get-file-info for every quality and measures real bitrates ---
if (pathname === "/api/quality-test") {
  const token = resolveToken(query.token);
  if (!token) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Нет токена — откройте приложение, оно передаёт токен автоматически" }));
    return;
  }

  const trackId = String(query.id || "126067587");
  const qualities = String(query.qualities || "lq,nq,lossless").split(",").map((s) => s.trim());
  const codecs = ["flac", "aac", "he-aac", "mp3", "flac-mp4", "aac-mp4", "he-aac-mp4"];
  const transports = "encraw";

  try {
    // Track duration for bitrate math
    let durationMs = 0;
    if (query.durationMs) {
      durationMs = parseInt(query.durationMs, 10) || 0;
    } else {
      const tr = await yandexRequest(
        `https://api.music.yandex.net/tracks?track-ids=${encodeURIComponent(trackId)}`,
        token
      );
      const arr = Array.isArray(tr.data) ? tr.data : tr.data?.result || [];
      durationMs = parseInt(arr[0]?.durationMs || 0, 10);
    }

    const results = [];
    for (const q of qualities) {
      const ts = Math.floor(Date.now() / 1000);
      const sign = generateSign(trackId, q, codecs, transports, ts);
      const infoUrl = `https://api.music.yandex.net/get-file-info?ts=${ts}&trackId=${trackId}&quality=${q}&codecs=${encodeURIComponent(codecs.join(","))}&transports=${transports}&sign=${encodeURIComponent(sign)}`;
      const info = await yandexRequest(infoUrl, token);
      const d = info.data?.result?.downloadInfo || info.data?.downloadInfo;

      if (!d || !d.urls || !d.urls[0]) {
        results.push({ quality: q, error: JSON.stringify(info.data?.result?.error || info.data?.error || "downloadInfo отсутствует").slice(0, 120) });
        continue;
      }

      const url0 = d.urls[0];
      let contentLength = parseInt(d.fileSize || 0, 10) || 0;
      if (!contentLength) {
        try {
          const head = await httpsHead(url0);
          contentLength = head.contentLength;
        } catch (e) {}
      }
      const kbps =
        durationMs > 0 && contentLength > 0
          ? Math.round((contentLength * 8) / 1000 / (durationMs / 1000))
          : null;

      results.push({
        quality: q,
        codec: d.codec || d.codecs || "",
        encryption: d.encryption || "",
        fileSizeBytes: contentLength || null,
        kbps,
        preview: url0.includes("preview"),
        sizeMb: contentLength ? (contentLength / 1048576).toFixed(2) : null,
      });
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, track: trackId, durationMs, results }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
  return;
}


// --- API: Like / Unlike track (real likes, not just skip) ---
if (pathname === "/api/like" && req.method === "POST") {
  const token = resolveToken(query.token);
  if (!token) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, guest: true }));
    return;
  }
  const body = await parseBody(req);
  const trackId = String(body.id || "");
  if (!trackId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Missing id" }));
    return;
  }
  try {
    const accInfo = await getAccountInfo(token);
    if (!accInfo.loggedIn) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Token invalid" }));
      return;
    }
    // Working API shape (confirmed by probing): add-multiple supports add.
    // NOTE: actual "unlike" is not supported by the API for this token scope —
    // 14 request shapes were probed (dash/camel params, remove=1/true, form/json
    // body, DELETE, if-revision). Every call bumps revision but never removes
    // the track from the library, so we reject unlike upfront and keep UI honest.
    if (body.remove) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: false,
        unsupported: true,
        error: "Снятие лайка недоступно через API (подтверждено тестами)",
      }));
      return;
    }
    const addRemove = await yandexRequest(
      `https://api.music.yandex.net/users/${accInfo.user.uid}/likes/tracks/add-multiple` +
      `?track-ids=${encodeURIComponent(trackId)}` +
      (body.albumId ? `&album-ids=${encodeURIComponent(String(body.albumId))}` : ""),
      token, "POST", {}
    );
    console.log(
      `[LIKE] track=${trackId} album=${body.albumId || "-"} remove=0 -> status=${addRemove.status}`,
      JSON.stringify(addRemove.data).slice(0, 200)
    );
    const revision = addRemove.data?.revision ?? addRemove.data?.result?.revision ?? null;
    const ok = addRemove.status === 200;
    if (ok) {
      // The user's like library has changed — drop cached likes so the fresh state shows up
      invalidateApiCache("/likes/tracks");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok, liked: !body.remove, status: addRemove.status, revision }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
  return;
}

// --- API: Which of the passed ids are liked (batch heart states) ---
if (pathname === "/api/like-status") {
  const token = resolveToken(query.token);
  const ids = String(query.ids || "").split(",").filter(Boolean);
  if (!token || ids.length === 0) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ likedIds: [] }));
    return;
  }
  try {
    const accInfo = await getAccountInfo(token);
    if (!accInfo.loggedIn) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ likedIds: [] }));
      return;
    }
    const likes = await yandexCached(
      `https://api.music.yandex.net/users/${accInfo.user.uid}/likes/tracks`, token,
      60 * 1000
    );
    const rl = likes.data?.result ?? likes.data ?? {};
    const lib = rl?.library?.tracks || rl?.tracks || [];
    const set = new Set(lib.map((t) => String(t.id)));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ likedIds: ids.filter((i) => set.has(String(i))) }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
  return;
}

// --- API: User playlists list ---
if (pathname === "/api/playlists") {
  const token = resolveToken(query.token);
  if (!token) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ playlists: [], guest: true }));
    return;
  }
  try {
    const accInfo = await getAccountInfo(token);
    if (!accInfo.loggedIn) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ playlists: [], guest: true }));
      return;
    }
    // Yandex deprecated /users/{uid}/playlists (now requires `kinds`);
    // /playlists/list returns the full playlist list for the account.
    const resp = await yandexCached(
      `https://api.music.yandex.net/users/${accInfo.user.uid}/playlists/list`,
      token, 5 * 60 * 1000
    );
    const lists = Array.isArray(resp.data)
      ? resp.data
      : resp.data?.result || [];
    const clean = lists
      .filter((p) => p.kind != null)
      .map((p) => {
        let coverUri = null;
        if (p.coverUri) {
          coverUri = "https://" + p.coverUri.replace("%%", "200x200");
        } else if (Array.isArray(p.cover?.itemsUri) && p.cover.itemsUri[0]) {
          coverUri = "https://" + p.cover.itemsUri[0].replace("%%", "200x200");
        } else if (p.ogImage) {
          coverUri = "https://" + p.ogImage.replace("%%", "200x200");
        }
        return {
          kind: p.kind,
          uid: p.uid || accInfo.user.uid,
          title: p.title || "Без названия",
          trackCount: p.trackCount || (p.tracks ? p.tracks.length : 0),
          coverUri,
          revised: p.revised || null,
        };
      });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ playlists: clean }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
  return;
}

// --- API: Tracks of one playlist ---
if (pathname === "/api/playlist-tracks") {
  const token = resolveToken(query.token);
  const kind = query.kind;
  const ownerUid = query.uid || null;
  if (!token || !kind) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing kind or token" }));
    return;
  }
  try {
    const accInfo = ownerUid ? { user: { uid: ownerUid } } : await getAccountInfo(token);
    if (!accInfo.user?.uid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Token invalid" }));
      return;
    }
    const resp = await yandexCached(
      `https://api.music.yandex.net/users/${accInfo.user.uid}/playlists/${encodeURIComponent(String(kind))}`,
      token, 5 * 60 * 1000
    );
    const playlist = resp.data?.result || {};
    // Playlist track briefs: {id, albumId} — resolve full info in one batch
    const briefs = playlist.tracks || [];
    const ids = briefs.map((b) => String(b.id)).filter(Boolean);

    let byId = new Map();
    if (ids.length) {
      const items = await fetchTracksByIds(ids, token);
      byId = new Map(items.map((t) => [String(t.id), t]));
    }

    const title = playlist.title || "Плейлист";
    const clean = ids
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((t) => ({
        id: String(t.id),
        title: t.title,
        artists: t.artists ? t.artists.map((a) => a.name).join(", ") : "Unknown",
        album: t.albums && t.albums[0] ? t.albums[0].title : null,
        albumId: t.albums && t.albums[0] ? String(t.albums[0].id) : null,
        coverUri: t.coverUri
          ? "https://" + t.coverUri.replace("%%", "200x200")
          : t.ogImage
          ? "https://" + t.ogImage.replace("%%", "200x200")
          : null,
        durationMs: t.durationMs || 0,
      }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ title, coverUri: playlist.coverUri ? "https://" + playlist.coverUri.replace("%%", "200x200") : null, tracks: clean }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
  return;
}

  // --- API: Smart playlists («Подборки») from feed: daily / dejavu / premiere / missed ---
  if (pathname === "/api/smart-playlists") {
    const token = resolveToken(query.token);
    if (!token) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ playlists: [], guest: true }));
      return;
    }
    try {
      const resp = await yandexCached(
        "https://api.music.yandex.net/feed",
        token, 5 * 60 * 1000
      );
      const feed = resp.data?.result || resp.data || {};
      const variants = Array.isArray(feed.generatedPlaylists) ? feed.generatedPlaylists : [];

      // Типы генеративных подборок по контракту API (MarshalX/yandex-music-api):
      // playlistOfTheDay («Премьера»), recentTracks, neverHeard («Дежавю»), missedLikes,
      // origin, podcasts. Игровые смарты — это персональные музыкальные; podcasts не треки.
      const wanted = new Set(["playlistOfTheDay", "recentTracks", "neverHeard", "missedLikes", "origin", "day", "day-weekly", "monthly"]);
      const clean = [];
      for (const p of variants) {
        const type = p?.type || p?.data?.generatedPlaylistType;
        if (!type || !wanted.has(type) || p.ready === false || p?.data?.isBanner) continue;
        const da = p.data || p.playlist || {}; // data — сам плейлист
        const ids = (Array.isArray(da.tracks) ? da.tracks : [])
          .map((t) => String(t && typeof t === "object" ? (t.track ? t.track.id : t.id) : t))
          .filter(Boolean);
        const items = await fetchTracksByIds(ids, token);
        const byId = new Map(items.map((t) => [String(t.id), t]));
        const tracks = ids
          .map((id) => byId.get(id))
          .filter(Boolean)
          .map((t) => ({
            id: String(t.id),
            title: t.title,
            artists: t.artists ? t.artists.map((a) => a.name).join(", ") : "Unknown",
            album: t.albums && t.albums[0] ? t.albums[0].title : null,
            albumId: t.albums && t.albums[0] ? String(t.albums[0].id) : null,
            coverUri: t.coverUri
              ? "https://" + t.coverUri.replace("%%", "400x400")
              : t.ogImage
              ? "https://" + t.ogImage.replace("%%", "400x400")
              : null,
            durationMs: t.durationMs || 0,
          }));

        const coverSrc = da.coverUri || da.ogImage ||
          (da.cover && (da.cover.uri || (da.cover.itemsUri || [])[0]));
        clean.push({
          id: da.kind != null ? `${da.uid || da.owner || ""}:${da.kind}` : String(type),
          title: da.title || "Подборка",
          description: da.description || p.description || "",
          coverUri: coverSrc ? "https://" + String(coverSrc).replace("%%", "400x400") : null,
          tracks,
        });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ playlists: clean }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // --- API: Play audio report (proxy to api.music.yandex.net/play-audio) ---
  if (pathname === "/api/play-audio" && req.method === "POST") {
    const token = resolveToken(query.token);
    if (!token) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, guest: true }));
      return;
    }
    const body = await parseBody(req);
    if (!body.trackId || !body.playId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Missing trackId or playId" }));
      return;
    }
    const params = {
      "track-id": String(body.trackId),
      "album-id": String(body.albumId || ""),
      "play-id": String(body.playId),
      from: String(body.from || "web-mod"),
      "from-cache": "false",
      "total-played-seconds": String(Number(body.playedSeconds) || 0),
      "track-length-seconds": String(Number(body.trackLengthSeconds) || 0),
      "end-position-seconds": String(Number(body.endPositionSeconds) || 0),
      timestamp: new Date().toISOString(),
      "client-now": new Date().toISOString(),
    };
    try {
      const result = await httpsPostForm("https://api.music.yandex.net/play-audio", params, token);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: result.status === 200, status: result.status, data: result.data || result.raw || null }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // --- API: Audio Stream (with on-the-fly AES-CTR decryption) ---
  if (pathname === "/api/stream") {
    const trackId = query.id;
    const quality = query.quality || "nq"; // lossless, nq, lq
    const token = resolveToken(query.token);

    if (!trackId) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing track ID");
      return;
    }

    try {
      const { downloadInfo, cached } = await fetchDownloadInfo(token, trackId, quality);

      if (!downloadInfo || !downloadInfo.urls || !downloadInfo.urls[0]) {
        // rotate storage: clear cached bad entry
        downloadInfoCache.delete(`${quality}:${trackId}`);
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Download info not found" }));
        return;
      }

      const streamUrl = downloadInfo.urls[0];
      const aesKey = downloadInfo.key;
      const codec = downloadInfo.codec || "mp3";
      const contentType = codec.includes("flac") ? "audio/flac" : "audio/mpeg";

      // HTTP Range (seek support). CTR is a byte-aligned stream, so plain-text offset == encrypted offset.
      let rangeStart = 0;
      const rangeHeader = req.headers.range || "";
      const m = /^bytes=(\d+)-/.exec(rangeHeader);
      if (m) rangeStart = parseInt(m[1], 10) || 0;

      console.log(
        `[STREAM] track=${trackId} q=${quality} codec=${codec} ${cached ? "CACHED" : "fetched"} ` +
        `range=${rangeStart ? rangeStart + "-" : "full"}`
      );

      const storageReq = (withRange) => new Promise((resolve) => {
        const headers = {};
        if (withRange && rangeStart) headers["Range"] = `bytes=${rangeStart}-`;
        const r = https.get(streamUrl, { headers, family: 4 }, (upRes) => {
          clearTimeout(t);
          resolve(upRes);
        });
        // 30s неактивности = storage недоступен / завис
        const t = setTimeout(() => r.destroy(new Error("storage timeout")), 30000);
        r.on("error", (e) => { clearTimeout(t); resolve(null); });
      });

      let audioRes = await storageReq(!!rangeStart);

      // Storage may reject Range on signed URLs — fall back to a full fetch once
      if (!audioRes || (audioRes.statusCode >= 400 && rangeStart)) {
        if (audioRes) audioRes.resume();
        audioRes = await storageReq(false);
      }

      if (!audioRes) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("Stream error: storage unreachable");
        return;
      }

      if (audioRes.statusCode >= 400) {
        downloadInfoCache.delete(`${quality}:${trackId}`);
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(`Stream error: storage status ${audioRes.statusCode}`);
        return;
      }

      // Response status mirrors the storage one (200 full / 206 partial)
      const respStatus = rangeStart && audioRes.statusCode === 206 ? 206 : 200;
      const respHeaders = {
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
      };
      if (audioRes.headers["content-length"]) respHeaders["Content-Length"] = audioRes.headers["content-length"];
      if (audioRes.headers["content-range"]) respHeaders["Content-Range"] = audioRes.headers["content-range"];

      res.writeHead(respStatus, respHeaders);

      // Decrypt on-the-fly using AES-128-CTR (IV = counter advanced to range start)
      const keyBuffer = Buffer.from(aesKey, "hex");
      // If storage ignored Range and replied 200 with the whole file — start keystream at 0
      const decStart = rangeStart && audioRes.statusCode === 206 ? rangeStart : 0;
      const dec = ctrDecipherAt(keyBuffer, decStart);

      // Ошибки в пайпе не должны ронять весь процесс: подстраховываемся на всех звеньях
      const onRespError = () => { try { res.destroy(); } catch (e) {} };
      const onClientError = () => { try { audioRes.destroy(); } catch (e) {} };
      audioRes.on("error", onRespError);
      res.on("error", onClientError);
      res.on("close", () => { try { audioRes.destroy(); } catch (e) {} });

      if (dec instanceof stream.Transform) {
        dec.on("error", onRespError);
        audioRes.pipe(dec).pipe(res);
      } else {
        dec.transform.on("error", onRespError);
        dec.readable.on("error", onRespError);
        audioRes.pipe(dec.transform).pipe(res);
      }
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

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
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🎵 Yandex Music Web Wrapper running at http://0.0.0.0:${PORT}`);
});
