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

export async function fetchUserShortsFeed(accessToken, { userId = "user", limit = 30 } = {}) {
  const cacheKey = `shorts_feed:${userId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // Gather items from both subscriptions feed and liked videos
  const [feedRes, likedRes] = await Promise.allSettled([
    fetchUserSubscriptionsFeed(accessToken, { userId, limit: 30 }),
    fetchUserLikedVideos(accessToken, { userId, limit: 20 })
  ]);

  const candidates = [];
  if (feedRes.status === "fulfilled" && Array.isArray(feedRes.value?.items)) {
    candidates.push(...feedRes.value.items);
  }
  if (likedRes.status === "fulfilled" && Array.isArray(likedRes.value?.items)) {
    candidates.push(...likedRes.value.items);
  }

  // Filter for items that indicate shorts (#shorts, short duration or aspect)
  const shorts = candidates.filter((item) => {
    const title = (item.title || "").toLowerCase();
    return title.includes("#short") || title.includes("shorts");
  });

  // If filtered shorts from subscriptions are fewer than 10, include remaining feed items
  const combined = [...shorts];
  for (const item of candidates) {
    if (combined.length >= limit) break;
    if (!combined.some((s) => s.id === item.id)) {
      combined.push(item);
    }
  }

  const result = { items: combined.slice(0, limit) };
  setCached(cacheKey, result);
  return result;
}
