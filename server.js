const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = process.env.PORT || 3000;
const SECRET_KEY = "kzqU4XhfCaY6B6JTHODeq5";
const CLIENT_HEADER = "YandexMusicDesktopAppWindows/5.46.2";

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

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
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
