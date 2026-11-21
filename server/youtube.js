// YouTube metadata resolution, search, and streaming using yt-dlp.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sendJSON } from "./http-utils.js";

let cachedYtDlpPath = null;

export function findYtDlpBinary() {
  if (cachedYtDlpPath) return cachedYtDlpPath;

  if (process.env.YT_DLP_PATH && fs.existsSync(process.env.YT_DLP_PATH)) {
    cachedYtDlpPath = process.env.YT_DLP_PATH;
    return cachedYtDlpPath;
  }

  const candidates = [
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

// In-memory caches for info and search results to reduce yt-dlp latency
const infoCache = new Map();
const searchCache = new Map();
const INFO_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const SEARCH_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export function clearYouTubeCaches() {
  infoCache.clear();
  searchCache.clear();
}

export function fetchYouTubeInfo(videoId) {
  return new Promise((resolve, reject) => {
    const id = extractYouTubeVideoId(videoId);
    if (!id) {
      return reject(new Error("Invalid YouTube video ID"));
    }

    const cached = infoCache.get(id);
    if (cached && Date.now() - cached.timestamp < INFO_CACHE_TTL_MS) {
      return resolve(cached.data);
    }

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

        infoCache.set(id, { timestamp: Date.now(), data: info });
        resolve(info);
      } catch (err) {
        reject(new Error(`Failed to parse yt-dlp metadata JSON: ${err.message}`));
      }
    });
  });
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

export function createYouTubeHandler() {
  return async function handleYouTubeRequest(req, res) {
    const url = req.url || "";
    if (!url.startsWith("/api/youtube")) return false;

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

    sendJSON(res, 404, { error: "Not found" });
    return true;
  };
}
