// Pure YouTube watch history parsing (Google Takeout JSON/HTML, yt-dlp :ythistory)
// and merge/sanitization helpers shared by the client and server.

const YOUTUBE_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;
const DEFAULT_MAX_ITEMS = 500;

export function extractYouTubeIdFromText(input) {
  if (!input || typeof input !== "string") return null;
  const str = input.trim();
  if (!str) return null;

  if (str.startsWith("yt:") || str.startsWith("yt_")) {
    const raw = str.slice(3).trim();
    return YOUTUBE_ID_REGEX.test(raw) ? raw : null;
  }

  if (YOUTUBE_ID_REGEX.test(str)) {
    return str;
  }

  try {
    const url = new URL(str.includes("://") ? str : `https://${str}`);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();

    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (url.pathname === "/watch") {
        const v = url.searchParams.get("v");
        if (v && YOUTUBE_ID_REGEX.test(v)) return v;
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if (
        (parts[0] === "embed" || parts[0] === "v" || parts[0] === "shorts" || parts[0] === "live") &&
        parts[1] &&
        YOUTUBE_ID_REGEX.test(parts[1])
      ) {
        return parts[1];
      }
    } else if (host === "youtu.be") {
      const id = url.pathname.replace(/^\//, "").split("/")[0];
      if (id && YOUTUBE_ID_REGEX.test(id)) return id;
    }
  } catch {
    // Ignore malformed URLs
  }

  return null;
}

export function cleanTakeoutTitle(rawTitle) {
  const s = String(rawTitle || "").trim();
  if (!s) return "YouTube Video";
  // Google Takeout prefixes watch entries with "Watched "
  const stripped = s.replace(/^Watched\s+/i, "").trim();
  return stripped || s;
}

function decodeHtmlEntities(str) {
  return String(str || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    });
}

function parseTimestampMs(raw) {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (typeof raw !== "string") return 0;
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  // Normalize narrow no-break spaces and timezone labels that Takeout HTML sometimes uses
  const normalized = trimmed
    .replace(/\u202f|\u00a0/g, " ")
    .replace(/\s+/g, " ");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function sanitizeYouTubeHistoryItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = extractYouTubeIdFromText(raw.id || raw.videoId || raw.ytId || raw.url || raw.titleUrl);
  if (!id) return null;

  const title = String(raw.title || "").trim().slice(0, 300) || `YouTube Video (${id})`;
  const author = String(raw.author || raw.channel || "").trim().slice(0, 160) || "YouTube";
  const duration = Number.isFinite(Number(raw.duration)) && Number(raw.duration) > 0
    ? Math.floor(Number(raw.duration))
    : 0;
  const viewCount = Number.isFinite(Number(raw.viewCount)) && Number(raw.viewCount) > 0
    ? Math.floor(Number(raw.viewCount))
    : 0;
  const thumbnail =
    typeof raw.thumbnail === "string" && raw.thumbnail.startsWith("http")
      ? raw.thumbnail.slice(0, 500)
      : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  const watchedAt = parseTimestampMs(raw.watchedAt ?? raw.time);
  const source = raw.source === "tylertube" ? "tylertube" : "youtube";
  const watchedOnYouTube =
    raw.watchedOnYouTube !== undefined ? Boolean(raw.watchedOnYouTube) : source === "youtube";

  return {
    id,
    title,
    author,
    duration,
    thumbnail,
    viewCount,
    watchedAt,
    source,
    watchedOnYouTube
  };
}

// Parse Google Takeout `watch-history.json` (array of My Activity objects).
export function parseTakeoutWatchHistoryJson(input, { maxItems = DEFAULT_MAX_ITEMS } = {}) {
  let records;
  if (Array.isArray(input)) {
    records = input;
  } else if (typeof input === "string") {
    const parsed = JSON.parse(input);
    if (!Array.isArray(parsed)) {
      throw new Error("Expected a JSON array from Google Takeout watch-history.json");
    }
    records = parsed;
  } else {
    throw new Error("Invalid watch history JSON input");
  }

  const byId = new Map();
  for (const entry of records) {
    if (!entry || typeof entry !== "object") continue;
    const id = extractYouTubeIdFromText(entry.titleUrl || entry.url);
    if (!id) continue;

    // Skip deleted/unavailable placeholders that have no real title
    const rawTitle = String(entry.title || "").trim();
    if (
      /^Watched a video that has been removed$/i.test(rawTitle) ||
      /^Watched https?:\/\//i.test(rawTitle)
    ) {
      continue;
    }

    const title = cleanTakeoutTitle(rawTitle);
    const author =
      (Array.isArray(entry.subtitles) && entry.subtitles[0]?.name) ||
      entry.channel ||
      "YouTube";
    const watchedAt = parseTimestampMs(entry.time);

    const existing = byId.get(id);
    if (!existing || watchedAt > existing.watchedAt) {
      byId.set(id, {
        id,
        title,
        author: String(author).trim() || "YouTube",
        duration: 0,
        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        viewCount: 0,
        watchedAt,
        source: "youtube",
        watchedOnYouTube: true
      });
    }
  }

  return Array.from(byId.values())
    .sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0))
    .slice(0, maxItems);
}

// Parse Google Takeout `watch-history.html` (My Activity HTML export).
export function parseTakeoutWatchHistoryHtml(html, { maxItems = DEFAULT_MAX_ITEMS } = {}) {
  if (typeof html !== "string" || !html.trim()) {
    throw new Error("Empty HTML watch history file");
  }

  const byId = new Map();
  // Split into activity blocks; Takeout wraps each entry in an outer-cell / content-cell div
  const blocks = html.split(/class="content-cell[^"]*"/i);
  const candidates = blocks.length > 1 ? blocks.slice(1) : [html];

  const linkRegex = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  for (const block of candidates) {
    const snippet = block.slice(0, 2500);
    linkRegex.lastIndex = 0;

    let videoId = null;
    let videoTitle = "";
    let channelName = "";
    let lastLinkEnd = 0;

    let match;
    while ((match = linkRegex.exec(snippet)) !== null) {
      const href = decodeHtmlEntities(match[1]);
      const text = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, "")).trim();
      if (!videoId) {
        const id = extractYouTubeIdFromText(href);
        if (id) {
          videoId = id;
          videoTitle = text;
          lastLinkEnd = linkRegex.lastIndex;
        }
      } else if (!channelName && /youtube\.com\/(channel|@|c\/|user\/)/i.test(href)) {
        channelName = text;
        lastLinkEnd = linkRegex.lastIndex;
      }
    }

    if (!videoId) continue;
    if (!videoTitle || /^https?:\/\//i.test(videoTitle)) continue;

    // Timestamp typically follows the last <br> in the block
    const tail = snippet.slice(lastLinkEnd).split(/<\/div>/i)[0] || "";
    const textParts = tail
      .split(/<br\s*\/?>/i)
      .map((p) => decodeHtmlEntities(p.replace(/<[^>]+>/g, "")).trim())
      .filter(Boolean);

    let watchedAt = 0;
    for (let i = textParts.length - 1; i >= 0; i--) {
      const ts = parseTimestampMs(textParts[i]);
      if (ts > 0) {
        watchedAt = ts;
        break;
      }
    }

    const existing = byId.get(videoId);
    if (!existing || watchedAt > existing.watchedAt) {
      byId.set(videoId, {
        id: videoId,
        title: cleanTakeoutTitle(videoTitle),
        author: channelName || "YouTube",
        duration: 0,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        viewCount: 0,
        watchedAt,
        source: "youtube",
        watchedOnYouTube: true
      });
    }
  }

  return Array.from(byId.values())
    .sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0))
    .slice(0, maxItems);
}

// Auto-detect Google Takeout JSON or HTML format and parse it.
export function parseTakeoutWatchHistory(text, filename = "", options = {}) {
  const raw = String(text || "").trim();
  if (!raw) {
    throw new Error("Watch history file is empty");
  }
  const lowerName = String(filename || "").toLowerCase();
  const looksJson =
    lowerName.endsWith(".json") || raw.startsWith("[") || raw.startsWith("{");
  if (looksJson) {
    return parseTakeoutWatchHistoryJson(raw, options);
  }
  return parseTakeoutWatchHistoryHtml(raw, options);
}

function isGenericTitle(title, id) {
  return !title || title === "YouTube Video" || title === "Untitled" || title === `YouTube Video (${id})`;
}

// Merge two arrays of YouTube history items, keeping the newest watch timestamp and richest metadata.
export function mergeYouTubeHistory(baseItems = [], incomingItems = [], { maxItems = DEFAULT_MAX_ITEMS } = {}) {
  const byId = new Map();

  const upsert = (raw) => {
    const item = sanitizeYouTubeHistoryItem(raw);
    if (!item) return;

    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      return;
    }

    const incomingNewer = (item.watchedAt || 0) > (existing.watchedAt || 0);
    const title = !isGenericTitle(item.title, item.id)
      ? item.title
      : existing.title;
    const author =
      item.author && item.author !== "YouTube"
        ? item.author
        : existing.author;
    const duration = item.duration > 0 ? item.duration : existing.duration;
    const viewCount = item.viewCount > 0 ? item.viewCount : existing.viewCount;
    const thumbnail =
      item.thumbnail && !item.thumbnail.endsWith("/hqdefault.jpg")
        ? item.thumbnail
        : existing.thumbnail || item.thumbnail;

    byId.set(item.id, {
      id: item.id,
      title,
      author,
      duration,
      thumbnail,
      viewCount,
      watchedAt: Math.max(existing.watchedAt || 0, item.watchedAt || 0),
      source: incomingNewer ? item.source : existing.source,
      watchedOnYouTube: Boolean(existing.watchedOnYouTube || item.watchedOnYouTube)
    });
  };

  for (const item of baseItems) upsert(item);
  for (const item of incomingItems) upsert(item);

  return Array.from(byId.values())
    .sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0))
    .slice(0, maxItems);
}
