const https = require("https");
const crypto = require("crypto");
const stream = require("stream");
const { generateSign, yandexRequest } = require("../lib/yandex");
const url = require("url");

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
async function qualityTestHandler(req, res, ctx) {
  const parsedUrl = url.parse(req.url, true);
  const query = parsedUrl.query;
  const token = ctx.resolveToken(query.token);
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
      const tr = await ctx.yandexRequest(
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
      const info = await ctx.yandexRequest(infoUrl, token);
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
}

// --- API: Audio Stream (with on-the-fly AES-CTR decryption) ---
async function streamHandler(req, res, ctx) {
  const parsedUrl = url.parse(req.url, true);
  const query = parsedUrl.query;
  const trackId = query.id;
  const quality = query.quality || "nq"; // lossless, nq, lq
  const token = ctx.resolveToken(query.token);

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
}

module.exports = {
  qualityTestHandler,
  streamHandler,
};
