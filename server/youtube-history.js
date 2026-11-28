// Server-side YouTube watch history persistence + live sync via yt-dlp `:ythistory`.
//
// Because Google deprecated YouTube Data API v3 access to the Watch History (`HL`) playlist
// in 2016, TylerTube integrates real YouTube watch history through two complementary paths:
//   1. Live sync via `yt-dlp ":ythistory"` using browser cookies (`YOUTUBE_COOKIES_BROWSER`)
//      or a Netscape `cookies.txt` file (`YOUTUBE_COOKIES_FILE`, `data/youtube-cookies.txt`,
//      or a per-profile cookie file uploaded from the UI).
//   2. Direct import from Google Takeout (`watch-history.json` / `watch-history.html`).
// Both are merged with YouTube videos watched inside TylerTube and persisted per profile.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  extractYouTubeIdFromText,
  mergeYouTubeHistory,
  parseTakeoutWatchHistory,
  sanitizeYouTubeHistoryItem
} from "../src/lib/youtubeHistory.js";
import "./env.js";

const FILE_VERSION = 1;
const MAX_HISTORY_ITEMS = 500;
const ALLOWED_BROWSER_REGEX =
  /^(chrome|chromium|firefox|safari|edge|brave|opera|vivaldi)(:[a-zA-Z0-9 _.-]{1,64})?$/i;

function safeProfileFilename(profileId) {
  return String(profileId || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "default";
}

export function validateCookiesBrowser(browser) {
  if (!browser || typeof browser !== "string") return null;
  const trimmed = browser.trim();
  return ALLOWED_BROWSER_REGEX.test(trimmed) ? trimmed : null;
}

export function validateNetscapeCookiesText(text) {
  if (typeof text !== "string" || !text.trim()) {
    return { valid: false, error: "Cookies file is empty." };
  }
  const lines = text.split(/\r?\n/);
  let youtubeLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const cols = trimmed.split("\t");
    if (cols.length >= 7) {
      const domain = cols[0].toLowerCase();
      if (domain.includes("youtube.com") || domain.includes("google.com")) {
        youtubeLines += 1;
      }
    }
  }
  if (youtubeLines === 0) {
    return {
      valid: false,
      error:
        "No YouTube or Google cookies found. Export a Netscape-format cookies.txt from youtube.com (e.g. using Get cookies.txt LOCALLY)."
    };
  }
  return { valid: true, count: youtubeLines };
}

function emptyProfile() {
  return {
    items: [],
    removedIds: {},
    lastSyncedAt: 0,
    lastSyncSource: "",
    lastImportedAt: 0
  };
}

export function createYouTubeHistoryStore(
  filePath,
  { cookiesDir = path.join(path.dirname(filePath), "youtube-cookies") } = {}
) {
  let data = null;

  function load() {
    if (data) return data;
    data = { version: FILE_VERSION, profiles: {} };
    try {
      if (fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (parsed && typeof parsed.profiles === "object" && parsed.profiles) {
          for (const [id, prof] of Object.entries(parsed.profiles)) {
            if (!prof || typeof prof !== "object") continue;
            data.profiles[id] = {
              items: Array.isArray(prof.items)
                ? mergeYouTubeHistory([], prof.items, { maxItems: MAX_HISTORY_ITEMS })
                : [],
              removedIds:
                prof.removedIds && typeof prof.removedIds === "object" ? prof.removedIds : {},
              lastSyncedAt: Number(prof.lastSyncedAt) || 0,
              lastSyncSource: String(prof.lastSyncSource || ""),
              lastImportedAt: Number(prof.lastImportedAt) || 0
            };
          }
        }
      }
    } catch (err) {
      console.error(`[youtube-history] could not read ${filePath}: ${err.message}`);
    }
    return data;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, filePath);
    } catch (err) {
      console.error(`[youtube-history] failed to save ${filePath}: ${err.message}`);
    }
  }

  function getProfile(profileId) {
    const store = load();
    const key = profileId || "default";
    if (!store.profiles[key]) {
      store.profiles[key] = emptyProfile();
    }
    return store.profiles[key];
  }

  function getProfileCookiesPath(profileId) {
    return path.join(cookiesDir, `${safeProfileFilename(profileId)}.txt`);
  }

  function resolveSyncConfig(profileId, browserOverride = null) {
    const override = validateCookiesBrowser(browserOverride);
    if (override) {
      return {
        liveConfigured: true,
        cookieSource: "browser",
        cookiesFile: null,
        cookiesBrowser: override
      };
    }

    const profileCookieFile = getProfileCookiesPath(profileId);
    if (fs.existsSync(profileCookieFile)) {
      return {
        liveConfigured: true,
        cookieSource: "uploaded",
        cookiesFile: profileCookieFile,
        cookiesBrowser: null
      };
    }

    const envFile = process.env.YOUTUBE_COOKIES_FILE;
    if (envFile && fs.existsSync(envFile)) {
      return {
        liveConfigured: true,
        cookieSource: "env-file",
        cookiesFile: envFile,
        cookiesBrowser: null
      };
    }

    const sharedCookieFile = path.join(path.dirname(filePath), "youtube-cookies.txt");
    if (fs.existsSync(sharedCookieFile)) {
      return {
        liveConfigured: true,
        cookieSource: "data-file",
        cookiesFile: sharedCookieFile,
        cookiesBrowser: null
      };
    }

    const envBrowser = validateCookiesBrowser(process.env.YOUTUBE_COOKIES_BROWSER);
    if (envBrowser) {
      return {
        liveConfigured: true,
        cookieSource: "browser",
        cookiesFile: null,
        cookiesBrowser: envBrowser
      };
    }

    return {
      liveConfigured: false,
      cookieSource: "",
      cookiesFile: null,
      cookiesBrowser: null
    };
  }

  function buildResponse(profileId) {
    const prof = getProfile(profileId);
    const cfg = resolveSyncConfig(profileId);
    return {
      items: prof.items,
      sync: {
        liveConfigured: cfg.liveConfigured,
        cookieSource: cfg.cookieSource,
        browser: cfg.cookiesBrowser || "",
        lastSyncedAt: prof.lastSyncedAt || 0,
        lastSyncSource: prof.lastSyncSource || "",
        lastImportedAt: prof.lastImportedAt || 0
      }
    };
  }

  return {
    get(profileId) {
      return buildResponse(profileId);
    },

    resolveSyncConfig,

    recordWatch(profileId, rawItem) {
      const item = sanitizeYouTubeHistoryItem({
        ...rawItem,
        source: "tylertube",
        watchedOnYouTube: Boolean(rawItem?.watchedOnYouTube),
        watchedAt: rawItem?.watchedAt || Date.now()
      });
      if (!item) return null;
      const prof = getProfile(profileId);
      delete prof.removedIds[item.id];
      prof.items = mergeYouTubeHistory(prof.items, [item], { maxItems: MAX_HISTORY_ITEMS });
      save();
      return buildResponse(profileId);
    },

    importItems(profileId, rawItems, { source = "takeout", respectRemoved = false } = {}) {
      const prof = getProfile(profileId);
      const filtered = [];
      for (const raw of rawItems || []) {
        const clean = sanitizeYouTubeHistoryItem(raw);
        if (!clean) continue;
        if (respectRemoved && prof.removedIds[clean.id]) continue;
        delete prof.removedIds[clean.id];
        filtered.push(clean);
      }

      prof.items = mergeYouTubeHistory(prof.items, filtered, { maxItems: MAX_HISTORY_ITEMS });
      const now = Date.now();
      if (source === "yt-dlp") {
        prof.lastSyncedAt = now;
        prof.lastSyncSource = "yt-dlp";
      } else {
        prof.lastImportedAt = now;
      }
      save();
      return {
        importedCount: filtered.length,
        ...buildResponse(profileId)
      };
    },

    removeItem(profileId, videoId) {
      const id = extractYouTubeIdFromText(videoId);
      if (!id) return buildResponse(profileId);
      const prof = getProfile(profileId);
      prof.items = prof.items.filter((item) => item.id !== id);
      prof.removedIds[id] = Date.now();
      save();
      return buildResponse(profileId);
    },

    clear(profileId, { scope = "all" } = {}) {
      const prof = getProfile(profileId);
      if (scope === "youtube") {
        prof.items = prof.items.filter((item) => !item.watchedOnYouTube && item.source === "tylertube");
      } else if (scope === "tylertube") {
        prof.items = prof.items.filter((item) => item.watchedOnYouTube || item.source === "youtube");
      } else {
        prof.items = [];
        prof.removedIds = {};
      }
      save();
      return buildResponse(profileId);
    },

    saveCookies(profileId, cookiesText) {
      const check = validateNetscapeCookiesText(cookiesText);
      if (!check.valid) {
        const err = new Error(check.error);
        err.status = 400;
        throw err;
      }
      const target = getProfileCookiesPath(profileId);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, cookiesText, { mode: 0o600 });
      return buildResponse(profileId);
    },

    clearCookies(profileId) {
      const target = getProfileCookiesPath(profileId);
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
      }
      return buildResponse(profileId);
    }
  };
}

// Fetch the user's live YouTube Watch History via `yt-dlp ":ythistory"`.
export function fetchYouTubeWatchHistoryViaYtDlp({
  binary = "yt-dlp",
  cookiesFile = null,
  cookiesBrowser = null,
  limit = 60,
  spawnFn = spawn
} = {}) {
  return new Promise((resolve, reject) => {
    if (!cookiesFile && !cookiesBrowser) {
      return reject(
        new Error(
          "YouTube cookies are required for live history sync. Upload a cookies.txt file or set YOUTUBE_COOKIES_BROWSER in .env."
        )
      );
    }

    const maxItems = Math.max(1, Math.min(200, Number(limit) || 60));
    const args = [
      "--flat-playlist",
      "-J",
      "--no-warnings",
      "--playlist-end",
      String(maxItems)
    ];

    if (cookiesFile) {
      args.push("--cookies", cookiesFile);
    } else {
      const validBrowser = validateCookiesBrowser(cookiesBrowser);
      if (!validBrowser) {
        return reject(new Error(`Unsupported browser for cookies: ${cookiesBrowser}`));
      }
      args.push("--cookies-from-browser", validBrowser);
    }

    args.push(":ythistory");

    const child = spawnFn(binary, args, {
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
        const msg = stderr.trim();
        if (/sign in|login|cookies|authentication|not logged in/i.test(msg)) {
          return reject(
            new Error(
              "YouTube rejected the cookies or you are not signed in. Please export fresh cookies from youtube.com and try again."
            )
          );
        }
        if (/could not copy|permission denied|operation not permitted|keychain|database is locked/i.test(msg)) {
          return reject(
            new Error(
              "Could not read browser cookies directly (browser locked or OS permission denied). Export a cookies.txt file instead."
            )
          );
        }
        return reject(new Error(`yt-dlp history sync failed (code ${code}): ${msg || "unknown error"}`));
      }

      try {
        const rawJson = Buffer.concat(stdoutChunks).toString("utf8");
        const parsed = JSON.parse(rawJson);
        const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
        const syncedAt = Date.now();

        const items = entries
          .filter((entry) => entry && entry.id)
          .map((entry, idx) => {
            const bestThumb =
              Array.isArray(entry.thumbnails) && entry.thumbnails.length > 0
                ? entry.thumbnails[entry.thumbnails.length - 1]?.url || entry.thumbnail
                : entry.thumbnail || `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`;

            return sanitizeYouTubeHistoryItem({
              id: entry.id,
              title: entry.title || "YouTube Video",
              author: entry.uploader || entry.channel || "YouTube",
              duration: Number(entry.duration) || 0,
              thumbnail: bestThumb,
              viewCount: Number(entry.view_count) || 0,
              // Preserve YouTube's reverse-chronological order with 1s spacing
              watchedAt: syncedAt - idx * 1000,
              source: "youtube",
              watchedOnYouTube: true
            });
          })
          .filter(Boolean);

        resolve({ items, syncedAt });
      } catch (err) {
        reject(new Error(`Failed to parse yt-dlp history JSON: ${err.message}`));
      }
    });
  });
}

export { parseTakeoutWatchHistory };
