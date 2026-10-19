const https = require("https");
const crypto = require("crypto");

const SECRET_KEY = "kzqU4XhfCaY6B6JTHODeq5";
const CLIENT_HEADER = "YandexMusicDesktopAppWindows/5.46.2";
const YAM_HOST = "https://api.music.yandex.net";

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

module.exports = {
  YAM_HOST,
  CLIENT_HEADER,
  SECRET_KEY,
  generateSign,
  yandexRequest,
  httpsPostForm,
};
