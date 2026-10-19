const { cacheStats } = require("../lib/cache");
const url = require("url");

// --- API: Cache stats (diagnostic; no token required) ---
async function cacheStatsHandler(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(cacheStats()));
}

// --- API: Account Status / Login Verification ---
async function accountHandler(req, res, ctx) {
  const parsedUrl = url.parse(req.url, true);
  const query = parsedUrl.query;
  const token = ctx.resolveToken(query.token || req.headers["authorization"]);
  if (!token) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ loggedIn: false }));
    return;
  }

  try {
    const info = await ctx.getAccountInfo(token);
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
}

// --- API: Play audio report (proxy to api.music.yandex.net/play-audio) ---
async function playAudioHandler(req, res, ctx) {
  const parsedUrl = url.parse(req.url, true);
  const query = parsedUrl.query;
  const token = ctx.resolveToken(query.token);
  if (!token) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, guest: true }));
    return;
  }
  const body = await ctx.parseBody(req);
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
    const result = await ctx.httpsPostForm("https://api.music.yandex.net/play-audio", params, token);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: result.status === 200, status: result.status, data: result.data || result.raw || null }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

// --- API: Client diagnostic log ---
async function clientLogHandler(req, res, ctx) {
  try {
    const body = await ctx.parseBody(req);
    console.log(`[CLIENT-LOG]`, JSON.stringify(body));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

module.exports = {
  cacheStatsHandler,
  accountHandler,
  playAudioHandler,
  clientLogHandler,
};
