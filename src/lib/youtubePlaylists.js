// Pure helpers for YouTube custom playlists, playlist URL detection, and queue navigation.

const YOUTUBE_PLAYLIST_ID_REGEX = /^[a-zA-Z0-9_-]{2,64}$/;
const BARE_PLAYLIST_PREFIX_REGEX = /^(PL|UU|FL|RD|OLAK5uy_)[a-zA-Z0-9_-]{8,60}$|^(LL|WL)$/;

export function extractPlaylistIdFromInput(input) {
  if (!input || typeof input !== "string") return null;
  const str = input.trim();
  if (!str) return null;

  if (str.startsWith("ytpl:")) {
    const rawId = str.slice(5).trim();
    return YOUTUBE_PLAYLIST_ID_REGEX.test(rawId) ? rawId : null;
  }

  if (BARE_PLAYLIST_PREFIX_REGEX.test(str)) {
    return str;
  }

  try {
    const url = new URL(str.includes("://") ? str : `https://${str}`);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com" ||
      host === "youtu.be"
    ) {
      const list = url.searchParams.get("list");
      if (list && YOUTUBE_PLAYLIST_ID_REGEX.test(list)) {
        return list;
      }
    }
  } catch {
    // Ignore invalid URL parse errors
  }

  return null;
}

export function normalizePlaylistVideo(item) {
  if (!item) return null;
  const rawId = String(item.ytId || item.id || "").replace(/^yt_/, "").trim();
  if (!rawId) return null;
  return {
    id: rawId,
    title: String(item.title || `YouTube Video (${rawId})`).trim(),
    author: String(item.author || item.section || "YouTube").trim(),
    duration: Number(item.duration) || 0,
    thumbnail:
      item.thumbnail ||
      item.poster ||
      `https://i.ytimg.com/vi/${rawId}/hqdefault.jpg`,
    viewCount: Number(item.viewCount) || 0,
    ...(item.isShort ? { isShort: true } : {})
  };
}

export function toPlayableYouTubeVideo(item) {
  const norm = normalizePlaylistVideo(item);
  if (!norm) return null;
  const isShort = Boolean(norm.isShort || item?.isShort);
  return {
    id: `yt_${norm.id}`,
    ytId: norm.id,
    title: norm.title,
    duration: norm.duration,
    src: `yt:${norm.id}`,
    poster: norm.thumbnail,
    course: isShort ? "YouTube Shorts" : "YouTube",
    section: norm.author,
    isYouTube: true,
    ...(isShort ? { isShort: true } : {})
  };
}

function generateLocalPlaylistId() {
  return `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function createCustomPlaylist(
  playlists,
  { name, description = "", items = [], sourcePlaylistId = "", author = "Custom Playlist" } = {}
) {
  const cleanName = String(name || "").trim();
  if (!cleanName) return Array.isArray(playlists) ? playlists : [];

  const list = Array.isArray(playlists) ? playlists : [];
  const deduped = [];
  const seen = new Set();
  for (const rawItem of Array.isArray(items) ? items : []) {
    const norm = normalizePlaylistVideo(rawItem);
    if (!norm || seen.has(norm.id)) continue;
    seen.add(norm.id);
    deduped.push(norm);
  }

  const now = Date.now();
  const nextPlaylist = {
    id: generateLocalPlaylistId(),
    title: cleanName,
    description: String(description || "").trim(),
    author: String(author || "Custom Playlist").trim(),
    source: sourcePlaylistId ? "imported" : "custom",
    sourcePlaylistId: String(sourcePlaylistId || "").trim(),
    thumbnail: deduped[0]?.thumbnail || "",
    items: deduped,
    createdAt: now,
    updatedAt: now
  };

  return [nextPlaylist, ...list];
}

export function renameCustomPlaylist(playlists, playlistId, nextTitle) {
  const cleanTitle = String(nextTitle || "").trim();
  if (!cleanTitle || !Array.isArray(playlists)) return Array.isArray(playlists) ? playlists : [];
  const now = Date.now();
  return playlists.map((pl) =>
    pl.id === playlistId ? { ...pl, title: cleanTitle, updatedAt: now } : pl
  );
}

export function deleteCustomPlaylist(playlists, playlistId) {
  if (!Array.isArray(playlists)) return [];
  return playlists.filter((pl) => pl.id !== playlistId);
}

export function addVideoToPlaylist(playlists, playlistId, video) {
  const norm = normalizePlaylistVideo(video);
  if (!norm || !Array.isArray(playlists)) return Array.isArray(playlists) ? playlists : [];

  const now = Date.now();
  return playlists.map((pl) => {
    if (pl.id !== playlistId) return pl;
    const existing = Array.isArray(pl.items) ? pl.items : [];
    if (existing.some((v) => v.id === norm.id)) {
      return pl;
    }
    const nextItems = [...existing, norm];
    return {
      ...pl,
      items: nextItems,
      thumbnail: pl.thumbnail || norm.thumbnail,
      updatedAt: now
    };
  });
}

export function removeVideoFromPlaylist(playlists, playlistId, rawVideoId) {
  const cleanId = String(rawVideoId || "").replace(/^yt_/, "").trim();
  if (!cleanId || !Array.isArray(playlists)) return Array.isArray(playlists) ? playlists : [];

  const now = Date.now();
  return playlists.map((pl) => {
    if (pl.id !== playlistId) return pl;
    const nextItems = (pl.items || []).filter((v) => v.id !== cleanId);
    return {
      ...pl,
      items: nextItems,
      thumbnail: nextItems[0]?.thumbnail || "",
      updatedAt: now
    };
  });
}

export function moveVideoInPlaylist(playlists, playlistId, rawVideoId, direction) {
  const cleanId = String(rawVideoId || "").replace(/^yt_/, "").trim();
  if (!cleanId || !Array.isArray(playlists)) return Array.isArray(playlists) ? playlists : [];
  const delta = direction === "up" ? -1 : direction === "down" ? 1 : 0;
  if (!delta) return playlists;

  const now = Date.now();
  return playlists.map((pl) => {
    if (pl.id !== playlistId) return pl;
    const items = [...(pl.items || [])];
    const idx = items.findIndex((v) => v.id === cleanId);
    const targetIdx = idx + delta;
    if (idx === -1 || targetIdx < 0 || targetIdx >= items.length) return pl;
    const [moved] = items.splice(idx, 1);
    items.splice(targetIdx, 0, moved);
    return {
      ...pl,
      items,
      thumbnail: items[0]?.thumbnail || pl.thumbnail || "",
      updatedAt: now
    };
  });
}

export function getAdjacentPlaylistVideo(
  playlist,
  currentVideoId,
  delta = 1,
  { shuffle = false, randomFn = Math.random } = {}
) {
  const items = Array.isArray(playlist?.items) ? playlist.items : [];
  if (items.length === 0) return null;

  const currentRawId = String(currentVideoId || "").replace(/^yt_/, "").trim();
  const idx = items.findIndex((v) => String(v.id || "").replace(/^yt_/, "") === currentRawId);

  if (shuffle && items.length > 1) {
    const candidates = items.filter((_, i) => i !== idx);
    const pickIdx = Math.floor(Math.max(0, Math.min(0.999999, randomFn())) * candidates.length);
    return toPlayableYouTubeVideo(candidates[pickIdx] || items[0]);
  }

  const nextIdx =
    idx === -1
      ? 0
      : (idx + delta + items.length) % items.length;
  return toPlayableYouTubeVideo(items[nextIdx]);
}
