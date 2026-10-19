const url = require("url");

async function waveHandler(req, res, ctx) {
  const parsedUrl = url.parse(req.url, true);
  const query = parsedUrl.query;
  const token = ctx.resolveToken(query.token);
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
    const result = await ctx.yandexRequest(targetUrl, token, method, body);
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
}

async function rotorFeedbackHandler(req, res, ctx) {
  const parsedUrl = url.parse(req.url, true);
  const query = parsedUrl.query;
  const token = ctx.resolveToken(query.token);
  if (!token) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, guest: true }));
    return;
  }

  const body = await ctx.parseBody(req);
  const stationId = body.station || "user:onyourwave";
  const feedback = {
    type: body.type || "trackStarted",
    timestamp: new Date().toISOString(),
  };
  if (body.trackId) feedback.trackId = String(body.trackId);
  if (body.batchId) feedback.batchId = String(body.batchId);
  if (body.from) feedback.from = String(body.from);

  try {
    const result = await ctx.yandexRequest(
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
}

module.exports = {
  waveHandler,
  rotorFeedbackHandler,
};
