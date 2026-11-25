// YouTube metadata resolution, search, and streaming using yt-dlp.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sendJSON } from "./http-utils.js";
import { getValidAccessToken } from "./auth.js";
import {
  fetchUserSubscriptionsFeed,
  fetchUserLikedVideos,
  fetchUserShortsFeed
} from "./youtube-feed.js";

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
const INFO_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FORMATS_CACHE_MAX_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const URL_EXPIRE_MARGIN_MS = 5 * 60 * 1000; // Refresh 5 min before CDN expiry
const SEARCH_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export function clearYouTubeCaches() {
  infoCache.clear();
  formatsCache.clear();
  inFlightInfo.clear();
  searchCache.clear();
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
      const underCap = list.filter((f) => (Number(f.height) || 0) <= maxHeight);
      const candidates = underCap.length ? underCap : list;
      return [...candidates].sort((a, b) => {
        const ha = Number(a.height) || 0;
        const hb = Number(b.height) || 0;
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
            const bestThumb =
              Array.isArray(entry.thumbnails) && entry.thumbnails.length > 0
                ? entry.thumbnails[entry.thumbnails.length - 1]?.url || entry.thumbnail
                : entry.thumbnail || `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`;

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

export function createYouTubeHandler({ authStore } = {}) {
  return async function handleYouTubeRequest(req, res, next) {
    const url = req.url || "";
    if (!url.startsWith("/api/youtube")) {
      if (next) next();
      return false;
    }

    const [pathname, rawQuery = ""] = url.split("?");
    const params = new URLSearchParams(rawQuery);

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
