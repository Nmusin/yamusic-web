const url = require("url");

async function likesHandler(req, res, ctx) {
  const parsedUrl = url.parse(req.url, true);
  const query = parsedUrl.query;
  const { ok, token } = ctx.resolveToken(req);
  if (!ok || !token) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tracks: [], guest: true }));
    return;
  }

  try {
    // 1. Get user info (about → status fallback, nested/flat shapes)
    const accInfo = await ctx.getAccountInfo(token);
    if (!accInfo.loggedIn) {
      console.log("[LIKES] Cannot resolve account uid for likes");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tracks: [], guest: true }));
      return;
    }
    const uid = accInfo.user.uid;

    // 2. Get liked track IDs (short TTL: user can like something at any moment)
    const likes = await ctx.yandexCached(
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
    const items = await ctx.fetchTracksByIds(ids, token);

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
}

async function likeHandler(req, res, ctx) {
  const parsedUrl = url.parse(req.url, true);
  const query = parsedUrl.query;
  const { ok, token } = ctx.resolveToken(req);
  if (!ok || !token) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, guest: true }));
    return;
  }
  const body = await ctx.parseBody(req);
  const trackId = String(body.id || "");
  if (!trackId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Missing id" }));
    return;
  }
  try {
    const accInfo = await ctx.getAccountInfo(token);
    if (!accInfo.loggedIn) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Token invalid" }));
      return;
    }
    const uml = body.remove
      ? `https://api.music.yandex.net/users/${accInfo.user.uid}/likes/tracks/remove` +
        `?track-ids=${encodeURIComponent(trackId)}`
      : `https://api.music.yandex.net/users/${accInfo.user.uid}/likes/tracks/add-multiple` +
        `?track-ids=${encodeURIComponent(trackId)}` +
        (body.albumId ? `&album-ids=${encodeURIComponent(String(body.albumId))}` : "");
    const addRemove = await ctx.yandexRequest(uml, token, "POST", {});
    console.log(
      `[LIKE] track=${trackId} album=${body.albumId || "-"} remove=${body.remove ? "1" : "0"} -> status=${addRemove.status}`,
      JSON.stringify(addRemove.data).slice(0, 200)
    );
    const revision = addRemove.data?.revision ?? addRemove.data?.result?.revision ?? null;
    const isOk = addRemove.status === 200;
    if (isOk) {
      // The user's like library has changed — drop cached likes so the fresh state shows up
      ctx.invalidateApiCache("/likes/tracks");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: isOk, liked: !body.remove, status: addRemove.status, revision }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

async function likeStatusHandler(req, res, ctx) {
  const parsedUrl = url.parse(req.url, true);
  const query = parsedUrl.query;
  const { ok, token } = ctx.resolveToken(req);
  const ids = String(query.ids || "").split(",").filter(Boolean);
  if (!ok || !token || ids.length === 0) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ likedIds: [] }));
    return;
  }
  try {
    const accInfo = await ctx.getAccountInfo(token);
    if (!accInfo.loggedIn) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ likedIds: [] }));
      return;
    }
    const likes = await ctx.yandexCached(
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
}

module.exports = {
  likesHandler,
  likeHandler,
  likeStatusHandler,
};
