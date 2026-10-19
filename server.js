const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = process.env.PORT || 3000;
const SECRET_KEY = "kzqU4XhfCaY6B6JTHODeq5";
const CLIENT_HEADER = "YandexMusicDesktopAppWindows/5.46.2";
let lastToken = null; // last token seen in requests (for quality tests)

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

    const req = https.request(parsed, { method, headers }, (res) => {
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
    req.on("error", reject);
    if (postData) {
      req.write(JSON.stringify(postData));
    }
    req.end();
  });
}

function httpsPostForm(targetUrl, params) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const body = new URLSearchParams(params).toString();
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
      "User-Agent": "YandexMusic/5.46.2",
    };

    const req = https.request(parsed, { method: "POST", headers }, (res) => {
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
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        resolve({});
      }
    });
  });
}

// Resolve Yandex account info from a token. Tries /account/about, then /account/status.
// Handles both nested ({result:{account:{uid}}}) and flat ({result:{uid}}) shapes.
async function getAccountInfo(token) {
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
      return {
        loggedIn: true,
        user: {
          uid,
          login: account.login || r.login,
          fullName: account.fullName || account.displayName || account.login || r.fullName || r.login,
          avatarUrl: avatarRaw ? `https://avatars.yandex.net/get-yapic/${avatarRaw}/islands-200` : null,
          hasPlus: true, // Spoofed Plus
        },
      };
    }
    console.log(`[AUTH] ${ep} responded ${resp.status}, keys:`, JSON.stringify(Object.keys(r)).slice(0, 200));
  }
  return { loggedIn: false, error: "Invalid token" };
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  // Remember the most recent valid-looking token (used for server-side tests)
  if (query.token && String(query.token).length > 30) lastToken = String(query.token);

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

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

  // --- API: Account Status / Login Verification ---
  if (pathname === "/api/account") {
    const token = query.token || req.headers["authorization"] || null;
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
    const token = query.token || null;
    if (!text.trim()) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tracks: [] }));
      return;
    }

    try {
      const searchUrl = `https://api.music.yandex.net/search?text=${encodeURIComponent(text)}&type=track&page=0`;
      const result = await yandexRequest(searchUrl, token);
      const items = result.data?.tracks?.results || result.data?.result?.tracks?.items || [];
      const cleanTracks = items.map((t) => ({
        id: String(t.id),
        title: t.title,
        artists: t.artists ? t.artists.map((a) => a.name).join(", ") : "Unknown",
        album: t.albums && t.albums[0] ? t.albums[0].title : null,
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
    const token = query.token || null;
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

      // 2. Get liked track IDs
      const likes = await yandexRequest(
        `https://api.music.yandex.net/users/${uid}/likes/tracks`,
        token
      );
      const rawLibrary = likes.data?.result ?? likes.data ?? {};
      const likesList = rawLibrary?.library?.tracks || rawLibrary?.tracks || [];
      const ids = likesList.map((t) => String(t.id));
      if (ids.length === 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ tracks: [] }));
        return;
      }

      // 3. Fetch full track info in a single batch request
      const tracksResp = await yandexRequest(
        `https://api.music.yandex.net/tracks?track-ids=${encodeURIComponent(ids.join(","))}`,
        token
      );
      // The API may return the array at the top level or wrapped in {"result": [...]}
      const items = Array.isArray(tracksResp.data)
        ? tracksResp.data
        : tracksResp.data?.result || [];

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
    const token = query.token || null;
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

      // Filter out promo ads ("Промокод Upgrade")
      const cleanTracks = sequence
        .filter((item) => item.track && item.track.title !== "Промокод Upgrade")
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
    const token = query.token || null;
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
    const req = https.request(targetUrl, { method: "HEAD" }, (res) => {
      res.resume();
      resolve({
        status: res.statusCode,
        contentLength: parseInt(res.headers["content-length"] || "0", 10),
        contentType: res.headers["content-type"] || "",
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// --- API: Quality Test — probes get-file-info for every quality and measures real bitrates ---
if (pathname === "/api/quality-test") {
  const token = query.token || lastToken || null;
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

  // --- API: Audio Stream (with on-the-fly AES-CTR decryption) ---
  if (pathname === "/api/stream") {
    const trackId = query.id;
    const quality = query.quality || "nq"; // lossless, nq, lq
    const token = query.token || null;

    if (!trackId) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing track ID");
      return;
    }

    try {
      const ts = Math.floor(Date.now() / 1000);
      const codecs = ["flac", "aac", "he-aac", "mp3", "flac-mp4", "aac-mp4", "he-aac-mp4"];
      const transports = "encraw";
      const sign = generateSign(trackId, quality, codecs, transports, ts);

      const infoUrl = `https://api.music.yandex.net/get-file-info?ts=${ts}&trackId=${trackId}&quality=${quality}&codecs=${encodeURIComponent(codecs.join(","))}&transports=${transports}&sign=${encodeURIComponent(sign)}`;
      const fileInfoResp = await yandexRequest(infoUrl, token);
      const downloadInfo = fileInfoResp.data?.result?.downloadInfo || fileInfoResp.data?.downloadInfo;

      if (!downloadInfo || !downloadInfo.urls || !downloadInfo.urls[0]) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Download info not found", details: fileInfoResp.data }));
        return;
      }

      const streamUrl = downloadInfo.urls[0];
      const aesKey = downloadInfo.key;
      const codec = downloadInfo.codec || "mp3";
      const contentType = codec.includes("flac") ? "audio/flac" : "audio/mpeg";

      console.log(
        `[STREAM] track=${trackId} q=${quality} codec=${codec} fileSize=${downloadInfo.fileSize || "?"} ` +
        `enc=${downloadInfo.encryption || "?"} preview=${streamUrl.includes("preview") ? "YES" : "no"} ` +
        `url=${streamUrl.slice(0, 90)}...`
      );

      https.get(streamUrl, (audioRes) => {
        if (audioRes.statusCode !== 200) {
          res.writeHead(audioRes.statusCode, { "Content-Type": "text/plain" });
          res.end("Error fetching audio from storage");
          return;
        }

        // Set headers for audio playback
        res.writeHead(200, {
          "Content-Type": contentType,
          "Accept-Ranges": "none",
          "Cache-Control": "public, max-age=3600",
        });

        // Decrypt on-the-fly using AES-128-CTR with 16-zero IV
        const keyBuffer = Buffer.from(aesKey, "hex");
        const ivBuffer = Buffer.alloc(16, 0);
        const decipher = crypto.createDecipheriv("aes-128-ctr", keyBuffer, ivBuffer);

        audioRes.pipe(decipher).pipe(res);
      }).on("error", (err) => {
        if (!res.headersSent) res.writeHead(502);
        res.end("Stream error: " + err.message);
      });
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // --- Static Files ---
  let filePath = path.join(__dirname, "public", pathname === "/" ? "index.html" : pathname);
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
