// YouTube metadata resolution, search, and streaming using yt-dlp.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readBody, sendJSON } from "./http-utils.js";
import { getValidAccessToken } from "./auth.js";
import {
  fetchUserSubscriptionsFeed,
  fetchUserLikedVideos,
  fetchUserShortsFeed,
  fetchUserPlaylists,
  fetchUserPlaylistItems
} from "./youtube-feed.js";
import {
  fetchYouTubeWatchHistoryViaYtDlp,
  parseTakeoutWatchHistory,
  validateCookiesBrowser
} from "./youtube-history.js";

let cachedYtDlpPath = null;

export function findYtDlpBinary() {
  if (cachedYtDlpPath) return cachedYtDlpPath;

  if (process.env.YT_DLP_PATH && fs.existsSync(process.env.YT_DLP_PATH)) {
    cachedYtDlpPath = process.env.YT_DLP_PATH;
    return cachedYtDlpPath;
  }

  const candidates =
    process.platform === "win32"
      ? [
        path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", "yt-dlp.exe"),
        path.join(process.env.USERPROFILE || "", "scoop", "shims", "yt-dlp.exe"),
        "C:\\ProgramData\\chocolatey\\bin\\yt-dlp.exe"
      ]
      : [
        "/opt/homebrew/bin/yt-dlp",
        "/usr/local/bin/yt-dlp",
        path.join(process.env.HOME || "", ".local/bin/yt-dlp"),
        "/usr/bin/yt-dlp"
      ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      cachedYtDlpPath = candidate;
      return cachedYtDlpPath;
    }
  }

  cachedYtDlpPath = "yt-dlp";
  return cachedYtDlpPath;
}

// Resets cached binary (useful for tests)
export function resetCachedYtDlpPath() {
  cachedYtDlpPath = null;
}

const YOUTUBE_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;
const YOUTUBE_PLAYLIST_ID_REGEX = /^[a-zA-Z0-9_-]{2,64}$/;
const BARE_PLAYLIST_PREFIX_REGEX = /^(PL|UU|FL|RD|OLAK5uy_)[a-zA-Z0-9_-]{8,60}$|^(LL|WL)$/;

export function extractYouTubePlaylistId(input) {
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

export function extractYouTubeVideoId(input) {
  if (!input || typeof input !== "string") return null;
  const str = input.trim();

  if (str.startsWith("yt:")) {
    const rawId = str.slice(3).trim();
    return YOUTUBE_ID_REGEX.test(rawId) ? rawId : null;
  }

  if (YOUTUBE_ID_REGEX.test(str)) {
    return str;
  }

  try {
    const url = new URL(str.includes("://") ? str : `https://${str}`);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();

    if (host === "youtube.com" || host === "m.youtube.com") {
      if (url.pathname === "/watch") {
        const v = url.searchParams.get("v");
        if (v && YOUTUBE_ID_REGEX.test(v)) return v;
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if ((parts[0] === "embed" || parts[0] === "v" || parts[0] === "shorts" || parts[0] === "live") && parts[1]) {
        if (YOUTUBE_ID_REGEX.test(parts[1])) return parts[1];
      }
    } else if (host === "youtu.be") {
      const id = url.pathname.replace(/^\//, "");
      if (YOUTUBE_ID_REGEX.test(id)) return id;
    }
  } catch {
    // Ignore invalid URL parse errors
  }

  return null;
}

export function isYouTubeTarget(target) {
  return Boolean(extractYouTubeVideoId(target));
}

// In-memory caches for info, resolved stream formats, and search results to reduce yt-dlp latency
const infoCache = new Map();
const formatsCache = new Map();
const inFlightInfo = new Map();
const searchCache = new Map();
const playlistCache = new Map();
const INFO_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FORMATS_CACHE_MAX_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const URL_EXPIRE_MARGIN_MS = 5 * 60 * 1000; // Refresh 5 min before CDN expiry
const SEARCH_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const PLAYLIST_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export function clearYouTubeCaches() {
  infoCache.clear();
  formatsCache.clear();
  inFlightInfo.clear();
  searchCache.clear();
  playlistCache.clear();
}

export function invalidateYouTubeCache(videoId) {
  const id = extractYouTubeVideoId(videoId);
  if (!id) return;
  infoCache.delete(id);
  formatsCache.delete(id);
}

// Parse Google CDN `expire=<unix_sec>` query param from a direct stream URL.
export function extractUrlExpireMs(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    const exp = Number(parsed.searchParams.get("expire"));
    if (Number.isFinite(exp) && exp > 0) return exp * 1000;
  } catch {
    // Ignore invalid URLs
  }
  return null;
}

// Prefer codecs that seek quickly and decode lightly in ffmpeg: vp9 > avc1 > other > av01.
function videoCodecRank(vcodec) {
  const c = String(vcodec || "").toLowerCase();
  if (c.startsWith("vp9") || c.startsWith("vp09")) return 3;
  if (c.startsWith("avc1") || c.startsWith("h264")) return 2;
  if (c.startsWith("av01") || c.startsWith("av1")) return 0;
  return 1;
}

function isDirectHttpProtocol(protocol) {
  return protocol === "https" || protocol === "http";
}

function isHlsProtocol(protocol) {
  return protocol === "m3u8" || protocol === "m3u8_native";
}

// Format http_headers map into an ffmpeg `-headers` string (`Key: Value\r\n`).
export function formatFfmpegHeaders(headers) {
  if (!headers || typeof headers !== "object") return "";
  const lines = [];
  for (const [k, v] of Object.entries(headers)) {
    if (!k || v == null) continue;
    const key = String(k).replace(/[\r\n]/g, "").trim();
    const val = String(v).replace(/[\r\n]/g, "").trim();
    if (key && val) lines.push(`${key}: ${val}`);
  }
  return lines.length ? `${lines.join("\r\n")}\r\n` : "";
}

// Effective resolution (short edge for vertical 9:16 Shorts so 720x1280 is treated as 720p,
// while landscape 1280x720 or height-only metadata stays 720).
function formatResolution(f) {
  const h = Number(f?.height) || 0;
  const w = Number(f?.width) || 0;
  if (w > 0 && h > 0) return Math.min(w, h);
  return h;
}

// Pure selector: picks the best video + audio stream URLs for a target max height.
// Prefers direct HTTPS (fast HTTP Range seeking) and avoids AV1 when VP9/H.264 is available.
export function selectYouTubeStreams(formats, quality = 720) {
  if (!Array.isArray(formats) || formats.length === 0) return null;
  const maxHeight = Math.max(144, Number(quality) || 720);

  const pickFromPool = (pool) => {
    const videoOnly = pool.filter(
      (f) => f && f.url && f.vcodec && f.vcodec !== "none" && (!f.acodec || f.acodec === "none")
    );
    const audioOnly = pool.filter(
      (f) => f && f.url && f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none")
    );
    const muxed = pool.filter(
      (f) => f && f.url && f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none"
    );

    const pickVideo = (list) => {
      if (!list.length) return null;
      const underCap = list.filter((f) => formatResolution(f) <= maxHeight);
      const candidates = underCap.length ? underCap : list;
      return [...candidates].sort((a, b) => {
        const ha = formatResolution(a);
        const hb = formatResolution(b);
        if (underCap.length) {
          if (hb !== ha) return hb - ha;
        } else if (ha !== hb) {
          return ha - hb;
        }
        const ca = videoCodecRank(a.vcodec);
        const cb = videoCodecRank(b.vcodec);
        if (cb !== ca) return cb - ca;
        return (Number(b.tbr) || Number(b.vbr) || 0) - (Number(a.tbr) || Number(a.vbr) || 0);
      })[0];
    };

    const pickAudio = (list) => {
      if (!list.length) return null;
      return [...list].sort((a, b) => {
        const opusA = String(a.acodec || "").toLowerCase().includes("opus") ? 1 : 0;
        const opusB = String(b.acodec || "").toLowerCase().includes("opus") ? 1 : 0;
        if (opusB !== opusA) return opusB - opusA;
        return (Number(b.abr) || Number(b.tbr) || 0) - (Number(a.abr) || Number(a.tbr) || 0);
      })[0];
    };

    const v = pickVideo(videoOnly);
    const a = pickAudio(audioOnly);
    if (v && a) {
      return {
        videoUrl: v.url,
        audioUrl: a.url,
        hasAudio: true,
        fps: Number(v.fps) > 0 ? Number(v.fps) : 0,
        headers: v.http_headers || a.http_headers || null,
        isDirect: isDirectHttpProtocol(v.protocol) && isDirectHttpProtocol(a.protocol)
      };
    }

    const m = pickVideo(muxed);
    if (m) {
      return {
        videoUrl: m.url,
        audioUrl: null,
        hasAudio: true,
        fps: Number(m.fps) > 0 ? Number(m.fps) : 0,
        headers: m.http_headers || null,
        isDirect: isDirectHttpProtocol(m.protocol)
      };
    }

    if (v) {
      return {
        videoUrl: v.url,
        audioUrl: null,
        hasAudio: false,
        fps: Number(v.fps) > 0 ? Number(v.fps) : 0,
        headers: v.http_headers || null,
        isDirect: isDirectHttpProtocol(v.protocol)
      };
    }

    return null;
  };

  const directPool = formats.filter((f) => f && isDirectHttpProtocol(f.protocol));
  const directPick = pickFromPool(directPool);
  if (directPick) return directPick;

  const hlsPool = formats.filter((f) => f && isHlsProtocol(f.protocol));
  return pickFromPool(hlsPool);
}

function computeFormatsExpiryMs(formats, now) {
  let earliest = now + FORMATS_CACHE_MAX_TTL_MS;
  for (const f of formats) {
    if (!f || !isDirectHttpProtocol(f.protocol) || !f.url) continue;
    const exp = extractUrlExpireMs(f.url);
    if (exp && exp - URL_EXPIRE_MARGIN_MS < earliest) {
      earliest = exp - URL_EXPIRE_MARGIN_MS;
    }
  }
  return Math.max(now + 60 * 1000, earliest);
}

function fetchYouTubeRawInfo(id, { forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh) {
    const cachedInfo = infoCache.get(id);
    const cachedFormats = formatsCache.get(id);
    if (
      cachedInfo &&
      cachedFormats &&
      now - cachedInfo.timestamp < INFO_CACHE_TTL_MS &&
      now < cachedFormats.expiresAt
    ) {
      return Promise.resolve({ info: cachedInfo.data, formats: cachedFormats.formats });
    }
    const pending = inFlightInfo.get(id);
    if (pending) return pending;
  }

  const promise = new Promise((resolve, reject) => {
    const binary = findYtDlpBinary();
    const args = [
      "-J",
      "--no-playlist",
      "--no-warnings",
      `https://www.youtube.com/watch?v=${id}`
    ];

    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdoutChunks = [];
    let stderr = "";

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));

    child.on("error", (err) => {
      reject(new Error(`Failed to execute yt-dlp: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp exited with code ${code}: ${stderr.trim() || "unknown error"}`));
      }

      try {
        const rawJson = Buffer.concat(stdoutChunks).toString("utf8");
        const parsed = JSON.parse(rawJson);
        const bestThumb =
          Array.isArray(parsed.thumbnails) && parsed.thumbnails.length > 0
            ? parsed.thumbnails[parsed.thumbnails.length - 1]?.url || parsed.thumbnail
            : parsed.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

        const info = {
          id,
          title: parsed.title || "YouTube Video",
          duration: Number(parsed.duration) || 0,
          thumbnail: bestThumb,
          author: parsed.uploader || parsed.channel || "YouTube",
          channelId: parsed.channel_id || "",
          description: parsed.description || "",
          viewCount: Number(parsed.view_count) || 0,
          uploadDate: parsed.upload_date || ""
        };

        const formats = Array.isArray(parsed.formats) ? parsed.formats : [];
        const ts = Date.now();
        infoCache.set(id, { timestamp: ts, data: info });
        if (formats.length > 0) {
          formatsCache.set(id, {
            timestamp: ts,
            expiresAt: computeFormatsExpiryMs(formats, ts),
            formats
          });
        }
        resolve({ info, formats });
      } catch (err) {
        reject(new Error(`Failed to parse yt-dlp metadata JSON: ${err.message}`));
      }
    });
  });

  inFlightInfo.set(id, promise);
  promise.finally(() => {
    if (inFlightInfo.get(id) === promise) inFlightInfo.delete(id);
  });
  return promise;
}

export function fetchYouTubeInfo(videoId) {
  const id = extractYouTubeVideoId(videoId);
  if (!id) {
    return Promise.reject(new Error("Invalid YouTube video ID"));
  }
  const cached = infoCache.get(id);
  if (cached && Date.now() - cached.timestamp < INFO_CACHE_TTL_MS) {
    return Promise.resolve(cached.data);
  }
  return fetchYouTubeRawInfo(id).then(({ info }) => info);
}

// Resolves direct video + audio stream URLs for a YouTube video at the requested quality.
// Reuses cached yt-dlp format data so seeks and quality/speed changes do not re-run yt-dlp.
export async function resolveYouTubeStreamUrls(videoId, quality = 720, { forceRefresh = false } = {}) {
  const id = extractYouTubeVideoId(videoId);
  if (!id) {
    throw new Error("Invalid YouTube video ID for streaming");
  }
  const { info, formats } = await fetchYouTubeRawInfo(id, { forceRefresh });
  const selected = selectYouTubeStreams(formats, quality);
  return {
    info,
    duration: info.duration || 0,
    ...(selected || { videoUrl: null, audioUrl: null, hasAudio: true, fps: 0, headers: null, isDirect: false })
  };
}

export function searchYouTube(query, limit = 20) {
  return new Promise((resolve, reject) => {
    const cleanQuery = String(query || "").trim();
    if (!cleanQuery) {
      return resolve({ query: "", items: [] });
    }

    const maxItems = Math.max(1, Math.min(50, Number(limit) || 20));
    const cacheKey = `${cleanQuery}:${maxItems}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < SEARCH_CACHE_TTL_MS) {
      return resolve(cached.data);
    }

    const binary = findYtDlpBinary();
    const args = [
      `ytsearch${maxItems}:${cleanQuery}`,
      "--flat-playlist",
      "-J",
      "--no-warnings"
    ];

    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdoutChunks = [];
    let stderr = "";

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));

    child.on("error", (err) => {
      reject(new Error(`Failed to execute yt-dlp: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp search exited with code ${code}: ${stderr.trim() || "unknown error"}`));
      }

      try {
        const rawJson = Buffer.concat(stdoutChunks).toString("utf8");
        const parsed = JSON.parse(rawJson);
        const entries = Array.isArray(parsed.entries) ? parsed.entries : [];

        const items = entries
          .filter((entry) => entry && entry.id)
          .map((entry) => {
            const bestThumb =
              Array.isArray(entry.thumbnails) && entry.thumbnails.length > 0
                ? entry.thumbnails[entry.thumbnails.length - 1]?.url || entry.thumbnail
                : entry.thumbnail || `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`;

            return {
              id: entry.id,
              title: entry.title || "Untitled",
              duration: Number(entry.duration) || 0,
              thumbnail: bestThumb,
              author: entry.uploader || entry.channel || "YouTube",
              viewCount: Number(entry.view_count) || 0
            };
          });

        const result = { query: cleanQuery, items };
        searchCache.set(cacheKey, { timestamp: Date.now(), data: result });
        resolve(result);
      } catch (err) {
        reject(new Error(`Failed to parse yt-dlp search JSON: ${err.message}`));
      }
    });
  });
}

export function searchYouTubeShorts(query, limit = 20) {
  return new Promise((resolve, reject) => {
    const rawQuery = String(query || "").trim();
    if (!rawQuery) {
      return resolve({ query: "", items: [] });
    }

    const cleanQuery = rawQuery.toLowerCase().includes("shorts")
      ? rawQuery
      : `shorts ${rawQuery}`;

    const maxItems = Math.max(1, Math.min(50, Number(limit) || 20));
    const cacheKey = `shorts:${cleanQuery}:${maxItems}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < SEARCH_CACHE_TTL_MS) {
      return resolve(cached.data);
    }

    const binary = findYtDlpBinary();
    const fetchLimit = Math.min(60, maxItems * 2);
    const args = [
      `ytsearch${fetchLimit}:${cleanQuery}`,
      "--flat-playlist",
      "-J",
      "--no-warnings"
    ];

    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdoutChunks = [];
    let stderr = "";

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));

    child.on("error", (err) => {
      reject(new Error(`Failed to execute yt-dlp: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp shorts search exited with code ${code}: ${stderr.trim() || "unknown error"}`));
      }

      try {
        const rawJson = Buffer.concat(stdoutChunks).toString("utf8");
        const parsed = JSON.parse(rawJson);
        const entries = Array.isArray(parsed.entries) ? parsed.entries : [];

        const items = entries
          .filter((entry) => {
            if (!entry || !entry.id) return false;
            const dur = Number(entry.duration);
            return !Number.isFinite(dur) || dur <= 90;
          })
          .slice(0, maxItems)
          .map((entry) => {
            // Prefer a medium-sized thumbnail (~320-480px) so Shorts grid cards decode smoothly
            let bestThumb = entry.thumbnail || `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`;
            if (Array.isArray(entry.thumbnails) && entry.thumbnails.length > 0) {
              const medium = entry.thumbnails.find(
                (t) => t?.url && Number(t.height) >= 240 && Number(t.height) <= 540
              );
              bestThumb =
                medium?.url ||
                entry.thumbnails[Math.min(1, entry.thumbnails.length - 1)]?.url ||
                bestThumb;
            }

            return {
              id: entry.id,
              title: entry.title || "Untitled Short",
              duration: Number(entry.duration) || 0,
              thumbnail: bestThumb,
              author: entry.uploader || entry.channel || "YouTube",
              viewCount: Number(entry.view_count) || 0,
              isShort: true
            };
          });

        const result = { query: rawQuery, items };
        searchCache.set(cacheKey, { timestamp: Date.now(), data: result });
        resolve(result);
      } catch (err) {
        reject(new Error(`Failed to parse yt-dlp shorts search JSON: ${err.message}`));
      }
    });
  });
}

// Resolves a public/unlisted YouTube playlist's metadata and video entries via yt-dlp.
export function fetchYouTubePlaylist(playlistInput, limit = 50) {
  return new Promise((resolve, reject) => {
    const playlistId = extractYouTubePlaylistId(playlistInput);
    if (!playlistId) {
      return reject(new Error("Invalid YouTube playlist ID or URL"));
    }

    const maxItems = Math.max(1, Math.min(100, Number(limit) || 50));
    const cacheKey = `${playlistId}:${maxItems}`;
    const cached = playlistCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < PLAYLIST_CACHE_TTL_MS) {
      return resolve(cached.data);
    }

    const binary = findYtDlpBinary();
    const args = [
      "--flat-playlist",
      "--playlist-end",
      String(maxItems),
      "-J",
      "--no-warnings",
      `https://www.youtube.com/playlist?list=${playlistId}`
    ];

    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdoutChunks = [];
    let stderr = "";

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));

    child.on("error", (err) => {
      reject(new Error(`Failed to execute yt-dlp: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(`yt-dlp playlist exited with code ${code}: ${stderr.trim() || "unknown error"}`)
        );
      }

      try {
        const rawJson = Buffer.concat(stdoutChunks).toString("utf8");
        const parsed = JSON.parse(rawJson);
        const entries = Array.isArray(parsed.entries) ? parsed.entries : [];

        const items = entries
          .filter((entry) => {
            if (!entry || !entry.id || !YOUTUBE_ID_REGEX.test(entry.id)) return false;
            const title = String(entry.title || "").trim();
            if (title === "[Deleted video]" || title === "[Private video]") return false;
            return true;
          })
          .map((entry) => {
            const bestThumb =
              Array.isArray(entry.thumbnails) && entry.thumbnails.length > 0
                ? entry.thumbnails[entry.thumbnails.length - 1]?.url || entry.thumbnail
                : entry.thumbnail || `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`;

            return {
              id: entry.id,
              title: entry.title || "Untitled",
              duration: Number(entry.duration) || 0,
              thumbnail: bestThumb,
              author: entry.uploader || entry.channel || parsed.uploader || parsed.channel || "YouTube",
              viewCount: Number(entry.view_count) || 0
            };
          });

        const playlistThumb =
          (Array.isArray(parsed.thumbnails) && parsed.thumbnails.length > 0
            ? parsed.thumbnails[parsed.thumbnails.length - 1]?.url
            : "") ||
          items[0]?.thumbnail ||
          "";

        const result = {
          id: parsed.id || playlistId,
          title: parsed.title || "YouTube Playlist",
          description: parsed.description || "",
          author: parsed.uploader || parsed.channel || items[0]?.author || "YouTube",
          thumbnail: playlistThumb,
          itemCount: Number(parsed.playlist_count) || items.length,
          source: "yt-dlp",
          items
        };

        playlistCache.set(cacheKey, { timestamp: Date.now(), data: result });
        resolve(result);
      } catch (err) {
        reject(new Error(`Failed to parse yt-dlp playlist JSON: ${err.message}`));
      }
    });
  });
}

// Spawns a yt-dlp process that emits a muxed MKV stream on stdout
export function spawnYouTubeStream({ videoId, seek = 0, quality = 720 }) {
  const id = extractYouTubeVideoId(videoId);
  if (!id) {
    throw new Error("Invalid YouTube video ID for streaming");
  }

  const qual = Number(quality) || 720;
  const binary = findYtDlpBinary();

  const args = [
    "-f",
    `bv*[height<=${qual}]+ba/b[height<=${qual}]/best`,
    "--remux-video",
    "mkv",
    "-o",
    "-"
  ];

  const seekSec = Number(seek) || 0;
  if (seekSec > 0.5) {
    args.push("--download-sections", `*${seekSec.toFixed(2)}-inf`);
  }

  args.push(`https://www.youtube.com/watch?v=${id}`);

  return spawn(binary, args, {
    stdio: ["ignore", "pipe", "ignore"]
  });
}

// Extract top creators from a user's watch history for tailoring Shorts searches.
export function extractHistorySeedCreators(historyItems, maxCreators = 4) {
  if (!Array.isArray(historyItems) || historyItems.length === 0) return [];
  const scores = new Map();
  const skip = new Set(["youtube", "youtube channel", "unknown", "untitled", ""]);

  historyItems.slice(0, 60).forEach((item, idx) => {
    const author = String(item?.author || "").trim();
    const key = author.toLowerCase();
    if (!author || skip.has(key) || author.length < 2) return;
    const recencyWeight = Math.max(1, 30 - idx * 0.5);
    const shortBonus = Number(item.duration) > 0 && Number(item.duration) <= 120 ? 12 : 0;
    const prev = scores.get(key) || { name: author, score: 0 };
    prev.score += recencyWeight + shortBonus;
    scores.set(key, prev);
  });

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCreators)
    .map((entry) => entry.name);
}

// Fire-and-forget warm-up of yt-dlp format resolution for upcoming Shorts.
export function prefetchYouTubeStreams(videoIds, quality = 480) {
  const validIds = Array.from(
    new Set(
      (Array.isArray(videoIds) ? videoIds : [])
        .map((raw) => extractYouTubeVideoId(String(raw || "")))
        .filter(Boolean)
    )
  ).slice(0, 3);

  for (const id of validIds) {
    resolveYouTubeStreamUrls(id, quality).catch(() => {
      // Best-effort background warm-up; errors are handled on actual playback
    });
  }
  return validIds;
}

const MAX_HISTORY_BODY_BYTES = 16 * 1024 * 1024; // 16 MB for Takeout JSON/HTML imports

export function createYouTubeHandler({
  authStore,
  historyStore,
  fetchHistoryViaYtDlp = fetchYouTubeWatchHistoryViaYtDlp
} = {}) {
  return async function handleYouTubeRequest(req, res, next) {
    const url = req.url || "";
    if (!url.startsWith("/api/youtube")) {
      if (next) next();
      return false;
    }

    const [pathname, rawQuery = ""] = url.split("?");
    const params = new URLSearchParams(rawQuery);

    // YouTube Watch History routes (GET / POST / DELETE)
    if (pathname === "/api/youtube/history" || pathname.startsWith("/api/youtube/history/")) {
      if (!historyStore) {
        sendJSON(res, 503, { error: "YouTube history store is not enabled on this server" });
        return true;
      }

      const profileId = authStore?.getUserIdFromRequest(req) || "default";

      if (pathname === "/api/youtube/history" && req.method === "GET") {
        sendJSON(res, 200, historyStore.get(profileId));
        return true;
      }

      if (pathname === "/api/youtube/history" && req.method === "DELETE") {
        const videoId = params.get("id");
        if (videoId) {
          sendJSON(res, 200, historyStore.removeItem(profileId, videoId));
        } else {
          const scope = params.get("scope") || "all";
          sendJSON(res, 200, historyStore.clear(profileId, { scope }));
        }
        return true;
      }

      if (pathname === "/api/youtube/history/record" && req.method === "POST") {
        try {
          const rawBody = await readBody(req, 256 * 1024);
          const payload = JSON.parse(rawBody || "{}");
          const result = historyStore.recordWatch(profileId, payload);
          if (!result) {
            sendJSON(res, 400, { error: "Missing or invalid YouTube video ID" });
            return true;
          }
          sendJSON(res, 200, result);
        } catch (err) {
          sendJSON(res, err.status || 400, { error: err.message || "Invalid request body" });
        }
        return true;
      }

      if (pathname === "/api/youtube/history/import" && req.method === "POST") {
        try {
          const rawBody = await readBody(req, MAX_HISTORY_BODY_BYTES);
          const payload = JSON.parse(rawBody || "{}");
          let items = [];
          if (Array.isArray(payload.items)) {
            items = payload.items;
          } else if (typeof payload.content === "string") {
            items = parseTakeoutWatchHistory(payload.content, payload.filename || "");
          } else {
            sendJSON(res, 400, {
              error: "Expected { items: [...] } or { content: '...' } from Google Takeout"
            });
            return true;
          }

          if (items.length === 0) {
            sendJSON(res, 400, {
              error: "No YouTube watch history entries were found in the uploaded file."
            });
            return true;
          }

          const result = historyStore.importItems(profileId, items, {
            source: "takeout",
            respectRemoved: false
          });
          sendJSON(res, 200, result);
        } catch (err) {
          sendJSON(res, err.status || 400, {
            error: err.message || "Failed to import YouTube watch history"
          });
        }
        return true;
      }

      if (pathname === "/api/youtube/history/cookies" && req.method === "POST") {
        try {
          const rawBody = await readBody(req, 1024 * 1024);
          const payload = JSON.parse(rawBody || "{}");
          const result = historyStore.saveCookies(profileId, payload.cookies || "");
          sendJSON(res, 200, result);
        } catch (err) {
          sendJSON(res, err.status || 400, { error: err.message || "Invalid cookies file" });
        }
        return true;
      }

      if (pathname === "/api/youtube/history/cookies" && req.method === "DELETE") {
        sendJSON(res, 200, historyStore.clearCookies(profileId));
        return true;
      }

      if (pathname === "/api/youtube/history/sync" && req.method === "POST") {
        try {
          const rawBody = await readBody(req, 64 * 1024);
          const payload = rawBody ? JSON.parse(rawBody) : {};
          const browserOverride = payload.browser ? validateCookiesBrowser(payload.browser) : null;
          if (payload.browser && !browserOverride) {
            sendJSON(res, 400, { error: "Unsupported browser name for cookie extraction" });
            return true;
          }

          const cfg = historyStore.resolveSyncConfig(profileId, browserOverride);
          if (!cfg.liveConfigured) {
            sendJSON(res, 400, {
              code: "COOKIES_REQUIRED",
              error:
                "Live YouTube history sync requires YouTube cookies. Upload a cookies.txt file or set YOUTUBE_COOKIES_BROWSER in .env."
            });
            return true;
          }

          const { items } = await fetchHistoryViaYtDlp({
            binary: findYtDlpBinary(),
            cookiesFile: cfg.cookiesFile,
            cookiesBrowser: cfg.cookiesBrowser,
            limit: payload.limit || 60
          });

          const result = historyStore.importItems(profileId, items, {
            source: "yt-dlp",
            respectRemoved: true
          });
          sendJSON(res, 200, { syncedCount: result.importedCount, ...result });
        } catch (err) {
          sendJSON(res, err.status || 502, {
            error: err.message || "Failed to sync YouTube watch history"
          });
        }
        return true;
      }

      sendJSON(res, 405, { error: "Method not allowed" });
      return true;
    }

    if (req.method !== "GET") {
      sendJSON(res, 405, { error: "Method not allowed" });
      return true;
    }

    if (pathname === "/api/youtube/info") {
      const target = params.get("v") || params.get("id") || params.get("url") || "";
      const videoId = extractYouTubeVideoId(target);
      if (!videoId) {
        sendJSON(res, 400, { error: "Missing or invalid YouTube video ID or URL" });
        return true;
      }

      try {
        const info = await fetchYouTubeInfo(videoId);
        sendJSON(res, 200, info);
      } catch (err) {
        sendJSON(res, 502, { error: err.message || "Failed to fetch YouTube info" });
      }
      return true;
    }

    if (pathname === "/api/youtube/search") {
      const q = params.get("q") || "";
      const limit = params.get("limit") || "20";
      if (!q.trim()) {
        sendJSON(res, 200, { query: "", items: [] });
        return true;
      }

      try {
        const result = await searchYouTube(q, limit);
        sendJSON(res, 200, result);
      } catch (err) {
        sendJSON(res, 502, { error: err.message || "Failed to search YouTube" });
      }
      return true;
    }

    if (pathname === "/api/youtube/shorts") {
      const q = params.get("q") || "";
      const limit = params.get("limit") || "20";
      if (!q.trim()) {
        sendJSON(res, 200, { query: "", items: [] });
        return true;
      }

      try {
        const result = await searchYouTubeShorts(q, limit);
        sendJSON(res, 200, result);
      } catch (err) {
        sendJSON(res, 502, { error: err.message || "Failed to search YouTube Shorts" });
      }
      return true;
    }

    // Authenticated personalized feeds
    if (pathname === "/api/youtube/feed") {
      if (!authStore) {
        sendJSON(res, 401, { error: "Auth is not enabled on this server", code: "AUTH_DISABLED" });
        return true;
      }

      const userId = authStore.getUserIdFromRequest(req);
      if (!userId) {
        sendJSON(res, 401, {
          error: "Sign in with Google to view your subscriptions feed",
          code: "AUTH_REQUIRED"
        });
        return true;
      }

      const accessToken = await getValidAccessToken(authStore, userId);
      if (!accessToken) {
        sendJSON(res, 401, {
          error: "Session expired or missing access token. Please sign in again.",
          code: "TOKEN_EXPIRED"
        });
        return true;
      }

      try {
        const feed = await fetchUserSubscriptionsFeed(accessToken, { userId });
        sendJSON(res, 200, feed);
      } catch (err) {
        sendJSON(res, 502, { error: err.message || "Failed to fetch YouTube feed" });
      }
      return true;
    }

    if (pathname === "/api/youtube/liked") {
      if (!authStore) {
        sendJSON(res, 401, { error: "Auth is not enabled on this server", code: "AUTH_DISABLED" });
        return true;
      }

      const userId = authStore.getUserIdFromRequest(req);
      if (!userId) {
        sendJSON(res, 401, {
          error: "Sign in with Google to view your liked videos",
          code: "AUTH_REQUIRED"
        });
        return true;
      }

      const accessToken = await getValidAccessToken(authStore, userId);
      if (!accessToken) {
        sendJSON(res, 401, {
          error: "Session expired. Please sign in again.",
          code: "TOKEN_EXPIRED"
        });
        return true;
      }

      try {
        const liked = await fetchUserLikedVideos(accessToken, { userId });
        sendJSON(res, 200, liked);
      } catch (err) {
        sendJSON(res, 502, { error: err.message || "Failed to fetch liked videos" });
      }
      return true;
    }

    if (pathname === "/api/youtube/playlist") {
      const target = params.get("list") || params.get("id") || params.get("url") || "";
      const limit = Math.max(1, Math.min(100, Number(params.get("limit")) || 50));
      const source = params.get("source") || "auto";
      const playlistId = extractYouTubePlaylistId(target);
      if (!playlistId) {
        sendJSON(res, 400, { error: "Missing or invalid YouTube playlist ID or URL" });
        return true;
      }

      const tryApiFetch = async () => {
        if (!authStore) return null;
        const userId = authStore.getUserIdFromRequest(req);
        if (!userId) return null;
        const accessToken = await getValidAccessToken(authStore, userId);
        if (!accessToken) return null;
        return fetchUserPlaylistItems(accessToken, playlistId, { limit });
      };

      try {
        if (source === "api") {
          const apiPlaylist = await tryApiFetch();
          if (apiPlaylist) {
            sendJSON(res, 200, apiPlaylist);
            return true;
          }
        }

        try {
          const playlist = await fetchYouTubePlaylist(playlistId, limit);
          sendJSON(res, 200, playlist);
          return true;
        } catch (ytDlpErr) {
          // Fallback to YouTube Data API for private/unlisted user playlists when signed in
          const apiPlaylist = await tryApiFetch().catch(() => null);
          if (apiPlaylist) {
            sendJSON(res, 200, apiPlaylist);
            return true;
          }
          throw ytDlpErr;
        }
      } catch (err) {
        sendJSON(res, 502, { error: err.message || "Failed to fetch YouTube playlist" });
      }
      return true;
    }

    if (pathname === "/api/youtube/playlists") {
      if (!authStore) {
        sendJSON(res, 401, { error: "Auth is not enabled on this server", code: "AUTH_DISABLED" });
        return true;
      }

      const userId = authStore.getUserIdFromRequest(req);
      if (!userId) {
        sendJSON(res, 401, {
          error: "Sign in with Google to view your YouTube playlists",
          code: "AUTH_REQUIRED"
        });
        return true;
      }

      const accessToken = await getValidAccessToken(authStore, userId);
      if (!accessToken) {
        sendJSON(res, 401, {
          error: "Session expired. Please sign in again.",
          code: "TOKEN_EXPIRED"
        });
        return true;
      }

      try {
        const playlists = await fetchUserPlaylists(accessToken, { userId });
        sendJSON(res, 200, playlists);
      } catch (err) {
        sendJSON(res, 502, { error: err.message || "Failed to fetch YouTube playlists" });
      }
      return true;
    }

    if (pathname === "/api/youtube/prefetch") {
      const rawIds = params.get("ids") || params.get("v") || "";
      const quality = Math.max(360, Math.min(1080, Number(params.get("quality")) || 480));
      const ids = rawIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const queued = prefetchYouTubeStreams(ids, quality);
      sendJSON(res, 202, { queued });
      return true;
    }

    if (pathname === "/api/youtube/shorts/tailored") {
      const limit = Math.max(6, Math.min(40, Number(params.get("limit")) || 24));
      const userId = authStore?.getUserIdFromRequest(req) || null;
      const profileId = userId || "default";
      const sources = [];
      const seen = new Set();
      const combined = [];
      let seedCreators = [];
      let authenticated = false;

      const pushUnique = (item, feedSource) => {
        if (!item?.id || seen.has(item.id)) return;
        seen.add(item.id);
        combined.push({
          ...item,
          isShort: true,
          feedSource: item.feedSource || feedSource
        });
      };

      // 1. Authenticated Google user: fetch UUSH Shorts playlists + short uploads + liked Shorts
      if (authStore && userId) {
        const accessToken = await getValidAccessToken(authStore, userId);
        if (accessToken) {
          authenticated = true;
          try {
            const oauthFeed = await fetchUserShortsFeed(accessToken, { userId, limit });
            if (Array.isArray(oauthFeed?.items) && oauthFeed.items.length > 0) {
              sources.push("subscriptions");
              for (const item of oauthFeed.items) {
                pushUnique(item, "subscription-short");
              }
            }
            if (Array.isArray(oauthFeed?.seedCreators)) {
              seedCreators.push(...oauthFeed.seedCreators);
            }
          } catch {
            // Fall through to history-based tailoring if YouTube API quota/token fails
          }
        }
      }

      // 2. YouTube watch history (live-synced / Takeout / TylerTube watches)
      const historyData = historyStore ? historyStore.get(profileId) : null;
      const historyItems = Array.isArray(historyData?.items) ? historyData.items : [];
      const historyCreators = extractHistorySeedCreators(historyItems, 4);
      if (historyCreators.length > 0) {
        sources.push("history");
        for (const creator of historyCreators) {
          if (!seedCreators.some((c) => c.toLowerCase() === creator.toLowerCase())) {
            seedCreators.push(creator);
          }
        }
      }

      // 3. Supplement with creator-tailored Shorts searches when needed (e.g. non-OAuth or sparse UUSH)
      if (combined.length < Math.min(14, limit) && seedCreators.length > 0) {
        const searchSeeds = seedCreators.slice(0, 2);
        const searchResults = await Promise.allSettled(
          searchSeeds.map((creator) => searchYouTubeShorts(`${creator} shorts`, 12))
        );
        const buckets = searchResults
          .filter((r) => r.status === "fulfilled" && Array.isArray(r.value?.items))
          .map((r) => r.value.items);

        // Interleave results across seed creators for variety
        const maxLen = buckets.reduce((m, b) => Math.max(m, b.length), 0);
        for (let i = 0; i < maxLen && combined.length < limit; i++) {
          for (const bucket of buckets) {
            if (bucket[i] && combined.length < limit) {
              pushUnique(bucket[i], "tailored-creator");
            }
          }
        }
      }

      // Also include any short videos from history if we still have room
      if (combined.length < limit && historyItems.length > 0) {
        for (const item of historyItems) {
          if (combined.length >= limit) break;
          const dur = Number(item.duration) || 0;
          const titleLower = String(item.title || "").toLowerCase();
          if ((dur > 0 && dur <= 90) || titleLower.includes("#short")) {
            pushUnique(item, "history-short");
          }
        }
      }

      sendJSON(res, 200, {
        items: combined.slice(0, limit),
        tailored: combined.length > 0,
        authenticated,
        sources: Array.from(new Set(sources)),
        seedCreators: seedCreators.slice(0, 6)
      });
      return true;
    }

    if (pathname === "/api/youtube/feed/shorts") {
      if (!authStore) {
        sendJSON(res, 401, { error: "Auth is not enabled on this server", code: "AUTH_DISABLED" });
        return true;
      }

      const userId = authStore.getUserIdFromRequest(req);
      if (!userId) {
        sendJSON(res, 401, {
          error: "Sign in with Google to view your personalized Shorts feed",
          code: "AUTH_REQUIRED"
        });
        return true;
      }

      const accessToken = await getValidAccessToken(authStore, userId);
      if (!accessToken) {
        sendJSON(res, 401, {
          error: "Session expired. Please sign in again.",
          code: "TOKEN_EXPIRED"
        });
        return true;
      }

      try {
        const shortsFeed = await fetchUserShortsFeed(accessToken, { userId });
        sendJSON(res, 200, shortsFeed);
      } catch (err) {
        sendJSON(res, 502, { error: err.message || "Failed to fetch Shorts feed" });
      }
      return true;
    }

    sendJSON(res, 404, { error: "Not found" });
    return true;
  };
}
