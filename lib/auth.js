const fs = require("fs");
const path = require("path");
const { yandexRequest, httpsPostForm } = require("./yandex");
const { tokenHash, getAccInfoCache, ACCOUNT_CACHE_TTL } = require("./cache");

// --- .env loader (KEY=VALUE lines; YM_TOKEN used as default account token) ---
const ENV_FILE = path.join(__dirname, "../.env");
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

function resolveToken(qt) {
  return qt || DEFAULT_TOKEN || null;
}

// Official Yandex Music OAuth credentials (from MarshalX/yandex-music-token)
const OAUTH_CLIENT_ID = "23cabbbdc6cd418abb4b39c32c41195d";
const OAUTH_CLIENT_SECRET = "53bc75238f0c4d08a118e51fe9203300";

const accInfoCache = getAccInfoCache();

// Resolve Yandex account info from a token. Tries /account/about, then /account/status.
// Handles both nested ({result:{account:{uid}}}) and flat ({result:{uid}}) shapes.
async function getAccountInfo(token) {
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
          hasPlus,
        },
      };
      accInfoCache.set(tHash, { info: result, ts: Date.now() });
      return result;
    }
    console.log(`[AUTH] ${ep} responded ${resp.status}, keys:`, JSON.stringify(Object.keys(r)).slice(0, 200));
  }
  return { loggedIn: false, error: "Invalid token" };
}

module.exports = {
  ENV_FILE,
  DEFAULT_TOKEN,
  resolveToken,
  tokenHash,
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  getAccountInfo,
};
