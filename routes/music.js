const url = require("url");

// --- API: Search ---
async function musicSearchHandler(req, res, ctx) {
  const parsedUrl = url.parse(req.url, true);
  const query = parsedUrl.query;
  const text = query.q || "";
  const token = ctx.resolveToken(query.token);
  if (!text.trim()) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tracks: [] }));
    return;
  }

  try {
    const searchUrl = `https://api.music.yandex.net/search?text=${encodeURIComponent(text)}&type=track&page=0`;
    const result = await ctx.yandexCached(searchUrl, token, 5 * 60 * 1000);
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
}

// --- API: User playlists ---
async function playlistsHandler(req, res, ctx) {
  const parsedUrl = url.parse(req.url, true);
  const query = parsedUrl.query;
  const token = ctx.resolveToken(query.token);
  if (!token) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ playlists: [], guest: true }));
    return;
  }
  try {
    const accInfo = await ctx.getAccountInfo(token);
    if (!accInfo.loggedIn) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ playlists: [], guest: true }));
      return;
    }
    // Yandex deprecated /users/{uid}/playlists (now requires `kinds`);
    // /playlists/list returns the full playlist list for the account.
    const resp = await ctx.yandexCached(
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
}

// --- API: Tracks of one playlist ---
async function playlistTracksHandler(req, res, ctx) {
  const parsedUrl = url.parse(req.url, true);
  const query = parsedUrl.query;
  const token = ctx.resolveToken(query.token);
  const kind = query.kind;
  const ownerUid = query.uid || null;
  if (!token || !kind) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing kind or token" }));
    return;
  }
  try {
    const accInfo = ownerUid ? { user: { uid: ownerUid } } : await ctx.getAccountInfo(token);
    if (!accInfo.user?.uid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Token invalid" }));
      return;
    }
    const resp = await ctx.yandexCached(
      `https://api.music.yandex.net/users/${accInfo.user.uid}/playlists/${encodeURIComponent(String(kind))}`,
      token, 5 * 60 * 1000
    );
    const playlist = resp.data?.result || {};
    // Playlist track briefs: {id, albumId} — resolve full info in one batch
    const briefs = playlist.tracks || [];
    const ids = briefs.map((b) => String(b.id)).filter(Boolean);

    let byId = new Map();
    if (ids.length) {
      const items = await ctx.fetchTracksByIds(ids, token);
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
}

// --- API: Smart playlists («Подборки») from feed: daily / dejavu / premiere / missed ---
async function smartPlaylistsHandler(req, res, ctx) {
  const parsedUrl = url.parse(req.url, true);
  const query = parsedUrl.query;
  const token = ctx.resolveToken(query.token);
  if (!token) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ playlists: [], guest: true }));
    return;
  }
  try {
    const resp = await ctx.yandexCached(
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
      const items = await ctx.fetchTracksByIds(ids, token);
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
}

module.exports = {
  musicSearchHandler,
  playlistsHandler,
  playlistTracksHandler,
  smartPlaylistsHandler,
};
