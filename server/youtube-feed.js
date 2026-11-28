// YouTube Feed Engine: fetches subscriptions, uploads, and liked videos using YouTube Data API v3.
const feedCache = new Map();
const FEED_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function clearFeedCaches() {
  feedCache.clear();
}

function getCached(key) {
  const item = feedCache.get(key);
  if (item && Date.now() - item.timestamp < FEED_CACHE_TTL_MS) {
    return item.data;
  }
  return null;
}

function setCached(key, data) {
  feedCache.set(key, { timestamp: Date.now(), data });
}

export async function fetchUserSubscriptions(accessToken, maxResults = 50) {
  const url = `https://www.googleapis.com/youtube/v3/subscriptions?part=snippet&mine=true&maxResults=${maxResults}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`YouTube API subscriptions request failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return (data.items || []).map((item) => ({
    channelId: item.snippet.resourceId.channelId,
    title: item.snippet.title,
    thumbnail: item.snippet.thumbnails?.default?.url || ""
  }));
}

export async function fetchChannelsUploadPlaylistIds(accessToken, channelIds) {
  if (!channelIds || channelIds.length === 0) return new Map();

  // YouTube channels API allows up to 50 IDs per call (costs only 1 quota unit)
  const slicedIds = channelIds.slice(0, 50);
  const url = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${slicedIds.join(",")}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`YouTube API channels request failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const map = new Map();
  for (const item of data.items || []) {
    const uploadsId = item.contentDetails?.relatedPlaylists?.uploads;
    if (uploadsId) {
      map.set(item.id, uploadsId);
    }
  }
  return map;
}

export async function fetchPlaylistRecentVideos(accessToken, playlistId, maxResults = 4) {
  const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=${maxResults}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!res.ok) {
    return [];
  }

  const data = await res.json();
  return (data.items || [])
    .map((item) => {
      const videoId = item.snippet?.resourceId?.videoId;
      if (!videoId) return null;
      const thumbs = item.snippet.thumbnails || {};
      const bestThumb =
        thumbs.maxres?.url ||
        thumbs.high?.url ||
        thumbs.medium?.url ||
        thumbs.default?.url ||
        `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

      return {
        id: videoId,
        title: item.snippet.title || "Untitled",
        author: item.snippet.channelTitle || "YouTube Channel",
        channelId: item.snippet.channelId,
        publishedAt: item.snippet.publishedAt || "",
        thumbnail: bestThumb
      };
    })
    .filter(Boolean);
}

export async function fetchUserSubscriptionsFeed(accessToken, { userId = "user", limit = 36 } = {}) {
  const cacheKey = `feed:${userId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // 1. Fetch channels the user is subscribed to
  const subs = await fetchUserSubscriptions(accessToken, 50);
  if (subs.length === 0) {
    const emptyResult = { items: [], subscriptionsCount: 0 };
    setCached(cacheKey, emptyResult);
    return emptyResult;
  }

  const channelIds = subs.map((s) => s.channelId);
  // 2. Fetch upload playlist IDs
  const uploadsMap = await fetchChannelsUploadPlaylistIds(accessToken, channelIds);

  // 3. To stay well within YouTube quota (1 unit per playlist call), query top 12 channels for latest uploads
  const uploadPlaylists = [];
  for (const [chId, upId] of uploadsMap.entries()) {
    if (uploadPlaylists.length < 12) {
      uploadPlaylists.push(upId);
    }
  }

  // Fetch playlist items concurrently
  const nestedResults = await Promise.all(
    uploadPlaylists.map((plId) => fetchPlaylistRecentVideos(accessToken, plId, 4))
  );

  const allVideos = nestedResults.flat();
  // Sort reverse chronological
  allVideos.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  const items = allVideos.slice(0, limit);
  const result = { items, subscriptionsCount: subs.length };
  setCached(cacheKey, result);
  return result;
}

export async function fetchUserLikedVideos(accessToken, { userId = "user", limit = 40 } = {}) {
  const cacheKey = `liked:${userId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=LL&maxResults=${Math.min(50, limit)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`YouTube API liked videos request failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const items = (data.items || [])
    .map((item) => {
      const videoId = item.snippet?.resourceId?.videoId;
      if (!videoId) return null;
      const thumbs = item.snippet.thumbnails || {};
      const bestThumb =
        thumbs.maxres?.url ||
        thumbs.high?.url ||
        thumbs.medium?.url ||
        thumbs.default?.url ||
        `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

      return {
        id: videoId,
        title: item.snippet.title || "Untitled",
        author: item.snippet.channelTitle || "YouTube Channel",
        channelId: item.snippet.channelId,
        publishedAt: item.snippet.publishedAt || "",
        thumbnail: bestThumb
      };
    })
    .filter(Boolean);

  const result = { items };
  setCached(cacheKey, result);
  return result;
}

export function parseIso8601Duration(iso) {
  if (!iso || typeof iso !== "string") return 0;
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return 0;
  const hours = Number(match[1]) || 0;
  const minutes = Number(match[2]) || 0;
  const seconds = Number(match[3]) || 0;
  return hours * 3600 + minutes * 60 + seconds;
}

export function channelIdToShortsPlaylistId(channelId) {
  const id = String(channelId || "").trim();
  if (id.startsWith("UC") && id.length > 2) {
    return `UUSH${id.slice(2)}`;
  }
  return null;
}

export async function fetchVideosDetails(accessToken, videoIds, { fetchFn = fetch } = {}) {
  const uniqueIds = Array.from(new Set((videoIds || []).filter(Boolean))).slice(0, 50);
  if (uniqueIds.length === 0) return new Map();

  const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${uniqueIds.join(",")}`;
  const res = await fetchFn(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!res.ok) {
    return new Map();
  }

  const data = await res.json();
  const map = new Map();
  for (const item of data.items || []) {
    if (!item?.id) continue;
    map.set(item.id, {
      duration: parseIso8601Duration(item.contentDetails?.duration || ""),
      viewCount: Number(item.statistics?.viewCount) || 0
    });
  }
  return map;
}

export async function fetchUserShortsFeed(accessToken, { userId = "user", limit = 30 } = {}) {
  const cacheKey = `shorts_feed:${userId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // 1. Fetch subscriptions + recent uploads + liked videos in parallel
  const [subsRes, feedRes, likedRes] = await Promise.allSettled([
    fetchUserSubscriptions(accessToken, 50),
    fetchUserSubscriptionsFeed(accessToken, { userId, limit: 36 }),
    fetchUserLikedVideos(accessToken, { userId, limit: 30 })
  ]);

  const subs = subsRes.status === "fulfilled" && Array.isArray(subsRes.value) ? subsRes.value : [];
  const seedCreators = subs.slice(0, 8).map((s) => s.title).filter(Boolean);

  // 2. Fetch dedicated channel Shorts playlists (UUSH...) for up to 14 subscribed channels
  const shortsPlaylistIds = subs
    .map((s) => channelIdToShortsPlaylistId(s.channelId))
    .filter(Boolean)
    .slice(0, 14);

  const uushNested = shortsPlaylistIds.length
    ? await Promise.all(
        shortsPlaylistIds.map((plId) =>
          fetchPlaylistRecentVideos(accessToken, plId, 4).catch(() => [])
        )
      )
    : [];

  const byId = new Map();
  const addCandidate = (item, extra = {}) => {
    if (!item?.id) return;
    const prev = byId.get(item.id);
    if (prev) {
      byId.set(item.id, {
        ...prev,
        ...item,
        fromUush: Boolean(prev.fromUush || extra.fromUush),
        feedSource: prev.fromUush ? prev.feedSource : extra.feedSource || prev.feedSource
      });
    } else {
      byId.set(item.id, {
        ...item,
        fromUush: Boolean(extra.fromUush),
        feedSource: extra.feedSource || "subscription",
        isShort: true
      });
    }
  };

  for (const item of uushNested.flat()) {
    addCandidate(item, { fromUush: true, feedSource: "subscription-short" });
  }
  if (likedRes.status === "fulfilled" && Array.isArray(likedRes.value?.items)) {
    for (const item of likedRes.value.items) {
      addCandidate(item, { feedSource: "liked" });
    }
  }
  if (feedRes.status === "fulfilled" && Array.isArray(feedRes.value?.items)) {
    for (const item of feedRes.value.items) {
      addCandidate(item, { feedSource: "subscription" });
    }
  }

  const candidates = Array.from(byId.values());

  // 3. Enrich with real duration & viewCount (1 quota unit for up to 50 videos)
  const detailsMap = await fetchVideosDetails(
    accessToken,
    candidates.map((c) => c.id)
  ).catch(() => new Map());

  const enriched = candidates.map((item) => {
    const details = detailsMap.get(item.id);
    const duration = details?.duration ?? item.duration ?? 0;
    const viewCount = details?.viewCount ?? item.viewCount ?? 0;
    const titleLower = (item.title || "").toLowerCase();
    const titleLooksShort = titleLower.includes("#short") || titleLower.includes("shorts");
    const isConfirmedShort =
      item.fromUush || (duration > 0 && duration <= 180) || titleLooksShort;

    return {
      id: item.id,
      title: item.title,
      author: item.author,
      channelId: item.channelId,
      publishedAt: item.publishedAt,
      thumbnail: item.thumbnail,
      duration,
      viewCount,
      feedSource: item.feedSource,
      fromUush: item.fromUush,
      isConfirmedShort,
      isShort: true
    };
  });

  // Sort: confirmed Shorts (<= 65s & UUSH first), then by publishedAt descending
  const trueShorts = enriched
    .filter((item) => item.isConfirmedShort)
    .sort((a, b) => {
      const aClassic = a.fromUush || (a.duration > 0 && a.duration <= 65) ? 1 : 0;
      const bClassic = b.fromUush || (b.duration > 0 && b.duration <= 65) ? 1 : 0;
      if (bClassic !== aClassic) return bClassic - aClassic;
      return (new Date(b.publishedAt).getTime() || 0) - (new Date(a.publishedAt).getTime() || 0);
    });

  // Only fall back to non-short items if user has almost no Shorts at all
  const finalList =
    trueShorts.length >= 6
      ? trueShorts.slice(0, limit)
      : [
          ...trueShorts,
          ...enriched
            .filter((item) => !item.isConfirmedShort)
            .sort((a, b) => (a.duration || 9999) - (b.duration || 9999))
        ].slice(0, limit);

  const items = finalList.map(({ fromUush, isConfirmedShort, ...rest }) => rest);
  const result = {
    items,
    subscriptionsCount: subs.length,
    confirmedShortsCount: trueShorts.length,
    seedCreators
  };
  setCached(cacheKey, result);
  return result;
}

export async function fetchUserPlaylists(accessToken, { userId = "user", limit = 50 } = {}) {
  const cacheKey = `playlists:${userId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const maxResults = Math.max(1, Math.min(50, Number(limit) || 50));
  const url = `https://www.googleapis.com/youtube/v3/playlists?part=snippet,contentDetails&mine=true&maxResults=${maxResults}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`YouTube API playlists request failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const items = (data.items || [])
    .map((item) => {
      if (!item?.id) return null;
      const snippet = item.snippet || {};
      const thumbs = snippet.thumbnails || {};
      const bestThumb =
        thumbs.maxres?.url ||
        thumbs.standard?.url ||
        thumbs.high?.url ||
        thumbs.medium?.url ||
        thumbs.default?.url ||
        "";

      return {
        id: item.id,
        title: snippet.title || "Untitled Playlist",
        description: snippet.description || "",
        author: snippet.channelTitle || "YouTube",
        thumbnail: bestThumb,
        itemCount: Number(item.contentDetails?.itemCount) || 0,
        publishedAt: snippet.publishedAt || "",
        source: "youtube"
      };
    })
    .filter(Boolean);

  const result = { items };
  setCached(cacheKey, result);
  return result;
}

export async function fetchUserPlaylistItems(accessToken, playlistId, { limit = 50 } = {}) {
  const cleanId = String(playlistId || "").trim();
  if (!cleanId) {
    throw new Error("Missing YouTube playlist ID");
  }

  const maxResults = Math.max(1, Math.min(50, Number(limit) || 50));
  const cacheKey = `playlist_items:${cleanId}:${maxResults}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const headers = { Authorization: `Bearer ${accessToken}` };
  const itemsUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${encodeURIComponent(cleanId)}&maxResults=${maxResults}`;
  const metaUrl = `https://www.googleapis.com/youtube/v3/playlists?part=snippet,contentDetails&id=${encodeURIComponent(cleanId)}`;

  const [itemsRes, metaRes] = await Promise.all([
    fetch(itemsUrl, { headers }),
    fetch(metaUrl, { headers }).catch(() => null)
  ]);

  if (!itemsRes.ok) {
    const errText = await itemsRes.text();
    throw new Error(`YouTube API playlistItems request failed (${itemsRes.status}): ${errText}`);
  }

  const itemsData = await itemsRes.json();
  let metaItem = null;
  if (metaRes && metaRes.ok) {
    const metaData = await metaRes.json().catch(() => null);
    metaItem = Array.isArray(metaData?.items) ? metaData.items[0] : null;
  }

  const items = (itemsData.items || [])
    .map((item) => {
      const snippet = item?.snippet || {};
      const videoId = snippet.resourceId?.videoId || item?.contentDetails?.videoId;
      const title = snippet.title || "";
      if (!videoId || title === "Deleted video" || title === "Private video") {
        return null;
      }
      const thumbs = snippet.thumbnails || {};
      const bestThumb =
        thumbs.maxres?.url ||
        thumbs.high?.url ||
        thumbs.medium?.url ||
        thumbs.default?.url ||
        `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

      return {
        id: videoId,
        title: title || "Untitled",
        author: snippet.videoOwnerChannelTitle || snippet.channelTitle || "YouTube",
        channelId: snippet.videoOwnerChannelId || snippet.channelId || "",
        publishedAt: snippet.publishedAt || "",
        duration: 0,
        viewCount: 0,
        thumbnail: bestThumb
      };
    })
    .filter(Boolean);

  const metaSnippet = metaItem?.snippet || {};
  const metaThumbs = metaSnippet.thumbnails || {};
  const playlistThumb =
    metaThumbs.maxres?.url ||
    metaThumbs.high?.url ||
    metaThumbs.medium?.url ||
    metaThumbs.default?.url ||
    items[0]?.thumbnail ||
    "";

  const result = {
    id: cleanId,
    title: metaSnippet.title || "YouTube Playlist",
    description: metaSnippet.description || "",
    author: metaSnippet.channelTitle || items[0]?.author || "YouTube",
    thumbnail: playlistThumb,
    itemCount: Number(metaItem?.contentDetails?.itemCount) || items.length,
    source: "youtube",
    items
  };
  setCached(cacheKey, result);
  return result;
}
