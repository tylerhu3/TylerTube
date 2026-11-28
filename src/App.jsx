import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Navbar from "./components/Navbar";
import SideMenu from "./components/SideMenu";
import VideoPlayer from "./components/VideoPlayer";
import VideoGrid from "./components/VideoGrid";
import HistoryPage from "./components/HistoryPage";
import FavoritesPage from "./components/FavoritesPage";
import UploadPage from "./components/UploadPage";
import YouTubePage from "./components/YouTubePage";
import ShortsPage from "./components/ShortsPage";
import { VIDEO_LIBRARY } from "./data/videos";
import { COLOR_THEMES } from "./data/themeColors";
import { readJSON, readString, writeString, writeJSON } from "./lib/storage";
import { createSyncStore } from "./lib/sync";
import { fetchVisitors, recordVisit } from "./lib/visitors";
import { fetchAuthStatus, logoutUser } from "./lib/auth";
import {
  mergeYouTubeHistory,
  parseTakeoutWatchHistory
} from "./lib/youtubeHistory";
import { getAdjacentPlaylistVideo } from "./lib/youtubePlaylists";
import {
  fetchYouTubeHistory,
  recordYouTubeHistoryWatch,
  importYouTubeHistoryItems,
  syncYouTubeHistoryLive,
  saveYouTubeHistoryCookies,
  clearYouTubeHistoryCookies,
  removeYouTubeHistoryItem,
  clearYouTubeHistory
} from "./lib/youtubeHistoryApi";

const STORAGE_KEY = "tylertube_watch_progress";
const FAVORITES_STORAGE_KEY = "tylertube_favorites";
const LAST_VIDEO_STORAGE_KEY = "tylertube_last_video_id";
const THEME_STORAGE_KEY = "tylertube_theme";
const COLOR_THEME_STORAGE_KEY = "tylertube_color_theme";
const SIDE_PLAYER_STORAGE_KEY = "tylertube_side_player_prefs";
const VIEW_MODE_STORAGE_KEY = "tylertube_view_mode";
const SYNC_META_STORAGE_KEY = "tylertube_sync_meta";
const YOUTUBE_RECENT_VIDEOS_KEY = "tylertube_youtube_recent_videos";
// Upload page (server/upload.js): the upload key, per device and never synced.
const UPLOAD_KEY_STORAGE_KEY = "tylertube_upload_key";
// Visitor log (server/visitors.js): this browser's visitor id and optional display name.
const VISITOR_KEYS = { idKey: "tylertube_visitor_id", nameKey: "tylertube_visitor_name" };

// Progress, favorites, last video and theme are mirrored to /api/state so they survive an
// origin change (new tunnel URL) and follow you across devices. View mode, side-player prefs
// and player settings stay per device. main.jsx awaits syncStore.initialSync() before render.
export const syncStore = createSyncStore({
  progressKey: STORAGE_KEY,
  metaKey: SYNC_META_STORAGE_KEY,
  fields: {
    favorites: { key: FAVORITES_STORAGE_KEY, json: true },
    lastVideoId: { key: LAST_VIDEO_STORAGE_KEY },
    theme: { key: THEME_STORAGE_KEY },
    colorTheme: { key: COLOR_THEME_STORAGE_KEY }
  }
});

function progressEntryChanged(prevEntry, nextEntry) {
  return (
    !prevEntry ||
    prevEntry.time !== nextEntry.time ||
    prevEntry.duration !== nextEntry.duration ||
    Boolean(prevEntry.completed) !== nextEntry.completed ||
    Boolean(prevEntry.watched) !== nextEntry.watched ||
    Boolean(prevEntry.hiddenFromHistory) !== nextEntry.hiddenFromHistory
  );
}

function detectInitialViewMode() {
  try {
    const saved = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    if (saved === "mobile" || saved === "desktop") {
      return saved;
    }
  } catch {
    // Ignore storage errors
  }
  if (typeof window !== "undefined" && window.innerWidth <= 768) {
    return "mobile";
  }
  return "desktop";
}

function loadSavedWatchProgress() {
  return readJSON(STORAGE_KEY, {});
}

function loadSavedFavorites() {
  return readJSON(FAVORITES_STORAGE_KEY, {});
}

function getInitialVideoId(initialProgress) {
  try {
    const savedVideoId = localStorage.getItem(LAST_VIDEO_STORAGE_KEY);
    if (savedVideoId && VIDEO_LIBRARY.some((v) => v.id === savedVideoId)) {
      return savedVideoId;
    }
  } catch {
    // Ignore storage errors
  }

  // Fallback to the most recently watched video in watchProgress
  let latestId = "";
  let latestTime = 0;
  for (const v of VIDEO_LIBRARY) {
    const entry = initialProgress?.[v.id];
    if (entry?.updatedAt && entry.updatedAt > latestTime) {
      latestTime = entry.updatedAt;
      latestId = v.id;
    }
  }
  if (latestId) return latestId;

  return VIDEO_LIBRARY[0]?.id || "";
}

export default function App() {
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY) || "light";
      document.documentElement.setAttribute("data-theme", saved);
      return saved;
    } catch {
      document.documentElement.setAttribute("data-theme", "light");
      return "light";
    }
  });
  const [colorTheme, setColorTheme] = useState(() => {
    try {
      const migrated = localStorage.getItem("tylertube_theme_migrated_v3");
      if (!migrated) {
        localStorage.setItem("tylertube_theme_migrated_v3", "true");
        const old = localStorage.getItem(COLOR_THEME_STORAGE_KEY);
        if (!old || old === "red" || old === "lightblue") {
          localStorage.setItem(COLOR_THEME_STORAGE_KEY, "pink");
          document.documentElement.setAttribute("data-color-theme", "pink");
          return "pink";
        }
      }
      const saved = localStorage.getItem(COLOR_THEME_STORAGE_KEY) || "pink";
      document.documentElement.setAttribute("data-color-theme", saved);
      return saved;
    } catch {
      document.documentElement.setAttribute("data-color-theme", "pink");
      return "pink";
    }
  });
  const [watchProgress, setWatchProgress] = useState(() =>
    loadSavedWatchProgress()
  );
  const [favorites, setFavorites] = useState(() => loadSavedFavorites());
  const [currentVideoId, setCurrentVideoId] = useState(() =>
    getInitialVideoId(watchProgress)
  );
  const [activeCustomVideo, setActiveCustomVideo] = useState(null);
  const [activeYouTubePlaylist, setActiveYouTubePlaylist] = useState(null);
  const [isYouTubePlaylistShuffled, setIsYouTubePlaylistShuffled] = useState(false);
  const [currentPage, setCurrentPage] = useState("youtube");
  const [uploadPageOpened, setUploadPageOpened] = useState(false);
  if (currentPage === "upload" && !uploadPageOpened) setUploadPageOpened(true);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [visitors, setVisitors] = useState(null); // null = not loaded / unavailable
  const [selfVisitor, setSelfVisitor] = useState(null);

  // Authentication & session state
  const [auth, setAuth] = useState({ configured: false, authenticated: false, user: null });
  const [authNotification, setAuthNotification] = useState(null);

  // Unified YouTube watch history (YouTube.com live sync / Takeout + TylerTube watches)
  const [youtubeHistory, setYoutubeHistory] = useState(() => {
    const saved = readJSON(YOUTUBE_RECENT_VIDEOS_KEY, []);
    if (!Array.isArray(saved)) return [];
    return mergeYouTubeHistory(
      [],
      saved.map((v) => ({
        ...v,
        source: v.source || "tylertube",
        watchedOnYouTube: Boolean(v.watchedOnYouTube)
      }))
    );
  });
  const [youtubeHistorySync, setYoutubeHistorySync] = useState({
    liveConfigured: false,
    cookieSource: "",
    browser: "",
    lastSyncedAt: 0,
    lastSyncSource: "",
    lastImportedAt: 0
  });
  const [youtubeInitialTab, setYoutubeInitialTab] = useState(null);

  const applyServerYouTubeHistory = useCallback((data) => {
    if (!data) return;
    if (Array.isArray(data.items)) {
      setYoutubeHistory(data.items);
      writeJSON(YOUTUBE_RECENT_VIDEOS_KEY, data.items.slice(0, 100));
    }
    if (data.sync && typeof data.sync === "object") {
      setYoutubeHistorySync(data.sync);
    }
  }, []);

  // Load server-persisted YouTube history on mount and whenever auth user changes
  useEffect(() => {
    let cancelled = false;
    fetchYouTubeHistory()
      .then((data) => {
        if (cancelled) return;
        const localSaved = readJSON(YOUTUBE_RECENT_VIDEOS_KEY, []);
        const localItems = Array.isArray(localSaved)
          ? localSaved.map((v) => ({
            ...v,
            source: v.source || "tylertube",
            watchedOnYouTube: Boolean(v.watchedOnYouTube)
          }))
          : [];
        const merged = mergeYouTubeHistory(data.items || [], localItems);
        setYoutubeHistory(merged);
        writeJSON(YOUTUBE_RECENT_VIDEOS_KEY, merged.slice(0, 100));
        if (data.sync) setYoutubeHistorySync(data.sync);
      })
      .catch(() => {
        // Keep localStorage history when server endpoint is unavailable
      });
    return () => {
      cancelled = true;
    };
  }, [auth.authenticated, auth.user?.id]);

  const handleRecordYouTubeWatch = useCallback(
    (item) => {
      const rawId = item?.ytId || item?.id?.replace(/^yt_/, "");
      if (!rawId) return;
      const entry = {
        id: rawId,
        title: item.title || "YouTube Video",
        author: item.author || item.section || "YouTube",
        duration: Number(item.duration) || 0,
        thumbnail:
          item.thumbnail ||
          item.poster ||
          `https://i.ytimg.com/vi/${rawId}/hqdefault.jpg`,
        viewCount: Number(item.viewCount) || 0,
        watchedAt: Date.now(),
        source: "tylertube",
        watchedOnYouTube: Boolean(item.watchedOnYouTube)
      };

      setYoutubeHistory((prev) => {
        const next = mergeYouTubeHistory(prev, [entry]);
        writeJSON(YOUTUBE_RECENT_VIDEOS_KEY, next.slice(0, 100));
        return next;
      });

      recordYouTubeHistoryWatch(entry)
        .then(applyServerYouTubeHistory)
        .catch(() => {
          // Local copy already persisted
        });
    },
    [applyServerYouTubeHistory]
  );

  const handleSyncYouTubeHistory = useCallback(
    async ({ browser = "", limit = 60 } = {}) => {
      const data = await syncYouTubeHistoryLive({ browser, limit });
      applyServerYouTubeHistory(data);
      return data;
    },
    [applyServerYouTubeHistory]
  );

  const handleImportYouTubeHistory = useCallback(
    async (fileText, filename = "") => {
      const parsedItems = parseTakeoutWatchHistory(fileText, filename, { maxItems: 500 });
      if (parsedItems.length === 0) {
        throw new Error("No YouTube watch history entries were found in that file.");
      }
      const data = await importYouTubeHistoryItems(parsedItems);
      applyServerYouTubeHistory(data);
      return data;
    },
    [applyServerYouTubeHistory]
  );

  const handleSaveYouTubeCookies = useCallback(
    async (cookiesText) => {
      const data = await saveYouTubeHistoryCookies(cookiesText);
      applyServerYouTubeHistory(data);
      return data;
    },
    [applyServerYouTubeHistory]
  );

  const handleClearYouTubeCookies = useCallback(async () => {
    const data = await clearYouTubeHistoryCookies();
    applyServerYouTubeHistory(data);
    return data;
  }, [applyServerYouTubeHistory]);

  const handleRemoveYouTubeHistoryItem = useCallback(
    (rawVideoId) => {
      const cleanId = String(rawVideoId || "").replace(/^yt_/, "");
      if (!cleanId) return;
      setYoutubeHistory((prev) => {
        const next = prev.filter((item) => item.id !== cleanId);
        writeJSON(YOUTUBE_RECENT_VIDEOS_KEY, next.slice(0, 100));
        return next;
      });
      removeYouTubeHistoryItem(cleanId)
        .then(applyServerYouTubeHistory)
        .catch(() => { });
    },
    [applyServerYouTubeHistory]
  );

  const handleClearYouTubeHistory = useCallback(
    (scope = "all") => {
      setYoutubeHistory((prev) => {
        let next = [];
        if (scope === "youtube") {
          next = prev.filter((item) => !item.watchedOnYouTube && item.source === "tylertube");
        } else if (scope === "tylertube") {
          next = prev.filter((item) => item.watchedOnYouTube || item.source === "youtube");
        }
        writeJSON(YOUTUBE_RECENT_VIDEOS_KEY, next.slice(0, 100));
        return next;
      });
      clearYouTubeHistory(scope)
        .then(applyServerYouTubeHistory)
        .catch(() => { });
    },
    [applyServerYouTubeHistory]
  );

  // Check auth and URL callback parameters on mount
  useEffect(() => {
    fetchAuthStatus().then((status) => {
      setAuth(status);
    });

    try {
      const searchParams = new URLSearchParams(window.location.search);
      const authErr = searchParams.get("auth_error");
      const authSuccess = searchParams.get("auth");
      const targetPage = searchParams.get("page");

      if (
        targetPage &&
        (targetPage === "home" ||
          targetPage === "youtube" ||
          targetPage === "shorts" ||
          targetPage === "upload")
      ) {
        setCurrentPage(targetPage);
      }

      if (authErr) {
        setAuthNotification(
          `Google Sign-In notice: ${decodeURIComponent(authErr)}. Showing default explore view.`
        );
      }

      if (authErr || authSuccess || targetPage) {
        // Clean URL search parameters without triggering a full page reload
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    } catch {
      // Ignore URL parsing errors
    }
  }, []);

  const handleLogout = useCallback(async () => {
    await logoutUser();
    setAuth((prev) => ({ ...prev, authenticated: false, user: null }));
    setCurrentPage((prev) => (prev === "upload" ? "youtube" : prev));
  }, []);

  // Log this visit once per page load; refresh the list whenever the menu opens.
  useEffect(() => {
    recordVisit(VISITOR_KEYS).then((v) => v && setSelfVisitor(v));
  }, []);

  useEffect(() => {
    if (!isMenuOpen) return;
    let cancelled = false;
    fetchVisitors().then((list) => {
      if (!cancelled && list) setVisitors(list);
    });
    return () => {
      cancelled = true;
    };
  }, [isMenuOpen]);

  const handleVisitorNameChange = useCallback(async (name) => {
    const v = await recordVisit(VISITOR_KEYS, name);
    if (!v) return;
    setSelfVisitor(v);
    setVisitors((prev) => (prev ? prev.map((p) => (p.id === v.id ? v : p)) : prev));
  }, []);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCourse, setSelectedCourse] = useState("ALL");
  const [selectedSection, setSelectedSection] = useState("ALL");
  const [isTheaterMode, setIsTheaterMode] = useState(false);
  const [isSidePlayer, setIsSidePlayer] = useState(false);
  const [viewMode, setViewMode] = useState(() => {
    const initial = detectInitialViewMode();
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-view-mode", initial);
    }
    return initial;
  });
  const hasManualViewOverrideRef = useRef(false);
  const [sidePlayerPrefs, setSidePlayerPrefs] = useState(() => ({
    width: 420,
    side: "right",
    vertical: "bottom",
    ...readJSON(SIDE_PLAYER_STORAGE_KEY, {})
  }));
  const [filterWatchStatus, setFilterWatchStatus] = useState("ALL");

  const courses = useMemo(() => {
    const unique = new Set();
    for (const v of VIDEO_LIBRARY) {
      if (v.course) unique.add(v.course);
    }
    return Array.from(unique);
  }, []);

  const sections = useMemo(() => {
    const unique = new Set();
    for (const v of VIDEO_LIBRARY) {
      if (selectedCourse !== "ALL" && v.course !== selectedCourse) continue;
      if (v.section) unique.add(v.section);
    }
    return Array.from(unique);
  }, [selectedCourse]);

  const handleCourseChange = useCallback((course) => {
    setSelectedCourse(course);
    setSelectedSection("ALL");
  }, []);

  const filteredVideos = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return VIDEO_LIBRARY.filter((v) => {
      if (selectedCourse !== "ALL" && v.course !== selectedCourse) {
        return false;
      }
      if (selectedSection !== "ALL" && v.section !== selectedSection) {
        return false;
      }
      if (filterWatchStatus === "IN_PROGRESS") {
        const prog = watchProgress[v.id];
        if (!prog || !(prog.time > 0) || prog.completed) return false;
      } else if (filterWatchStatus === "WATCHED") {
        const prog = watchProgress[v.id];
        if (!prog || (!prog.completed && !(prog.duration > 0 && prog.time >= prog.duration - 2))) {
          return false;
        }
      }
      if (!q) return true;
      return (
        v.title.toLowerCase().includes(q) ||
        v.description.toLowerCase().includes(q) ||
        (v.course && v.course.toLowerCase().includes(q)) ||
        (v.section && v.section.toLowerCase().includes(q))
      );
    });
  }, [searchQuery, selectedCourse, selectedSection, filterWatchStatus, watchProgress]);

  const historyItems = useMemo(() => {
    const items = [];
    for (const v of VIDEO_LIBRARY) {
      const prog = watchProgress[v.id];
      if (
        prog &&
        !prog.hiddenFromHistory &&
        (prog.time > 0 || prog.completed || prog.watched)
      ) {
        items.push({
          video: { ...v, historySource: "library" },
          progress: prog
        });
      }
    }

    for (const yt of youtubeHistory) {
      const videoId = `yt_${yt.id}`;
      const prog = watchProgress[videoId];
      const watchedAt = Math.max(prog?.updatedAt || 0, yt.watchedAt || 0);
      const effectiveProgress = prog && !prog.hiddenFromHistory
        ? {
          ...prog,
          duration: prog.duration > 0 ? prog.duration : yt.duration || 0,
          updatedAt: watchedAt
        }
        : {
          time: 0,
          duration: yt.duration || 0,
          completed: false,
          watched: true,
          updatedAt: yt.watchedAt || 0
        };

      items.push({
        video: {
          id: videoId,
          ytId: yt.id,
          title: yt.title || `YouTube Video (${yt.id})`,
          duration: yt.duration || 0,
          src: `yt:${yt.id}`,
          poster: yt.thumbnail || `https://i.ytimg.com/vi/${yt.id}/hqdefault.jpg`,
          course: "YouTube",
          section: yt.author || "YouTube",
          isYouTube: true,
          historySource: yt.watchedOnYouTube ? "youtube" : "tylertube"
        },
        progress: effectiveProgress
      });
    }

    items.sort((a, b) => (b.progress.updatedAt || 0) - (a.progress.updatedAt || 0));
    return items;
  }, [watchProgress, youtubeHistory]);

  const favoriteItems = useMemo(() => {
    const items = [];
    for (const v of VIDEO_LIBRARY) {
      const favEntry = favorites[v.id];
      if (favEntry) {
        items.push({
          video: v,
          addedAt: typeof favEntry === "object" ? favEntry.addedAt : Number(favEntry) || 0
        });
      }
    }
    items.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return items;
  }, [favorites]);

  const { inProgressCount, completedCount } = useMemo(() => {
    let inProg = 0;
    let comp = 0;
    for (const { progress } of historyItems) {
      const isDone = Boolean(
        progress?.completed ||
        (progress?.duration > 0 && progress?.time >= progress.duration - 1.5)
      );
      if (isDone) comp++;
      else inProg++;
    }
    return { inProgressCount: inProg, completedCount: comp };
  }, [historyItems]);

  const currentVideo = useMemo(() => {
    if (activeCustomVideo && activeCustomVideo.id === currentVideoId) {
      return activeCustomVideo;
    }
    return (
      VIDEO_LIBRARY.find((v) => v.id === currentVideoId) || activeCustomVideo || VIDEO_LIBRARY[0]
    );
  }, [currentVideoId, activeCustomVideo]);

  useEffect(() => {
    if (!currentVideo?.id) return;
    if (readString(LAST_VIDEO_STORAGE_KEY) === currentVideo.id) return;
    writeString(LAST_VIDEO_STORAGE_KEY, currentVideo.id);
    syncStore.touch("lastVideoId");
  }, [currentVideo?.id]);

  const activePlaylist =
    filteredVideos.length > 0 ? filteredVideos : VIDEO_LIBRARY;

  const handlePrev = useCallback(() => {
    if (currentVideo?.isYouTube && activeYouTubePlaylist?.items?.length > 0) {
      const prevVideo = getAdjacentPlaylistVideo(
        activeYouTubePlaylist,
        currentVideo.id,
        -1,
        { shuffle: isYouTubePlaylistShuffled }
      );
      if (prevVideo) {
        setActiveCustomVideo(prevVideo);
        setCurrentVideoId(prevVideo.id);
        handleRecordYouTubeWatch(prevVideo);
        return;
      }
    }
    const idx = activePlaylist.findIndex((v) => v.id === currentVideo?.id);
    const prevIdx =
      idx === -1
        ? 0
        : (idx - 1 + activePlaylist.length) % activePlaylist.length;
    setCurrentVideoId(activePlaylist[prevIdx].id);
  }, [
    activePlaylist,
    currentVideo,
    activeYouTubePlaylist,
    isYouTubePlaylistShuffled,
    handleRecordYouTubeWatch
  ]);

  const handleNext = useCallback(() => {
    if (currentVideo?.isYouTube && activeYouTubePlaylist?.items?.length > 0) {
      const nextVideo = getAdjacentPlaylistVideo(
        activeYouTubePlaylist,
        currentVideo.id,
        1,
        { shuffle: isYouTubePlaylistShuffled }
      );
      if (nextVideo) {
        setActiveCustomVideo(nextVideo);
        setCurrentVideoId(nextVideo.id);
        handleRecordYouTubeWatch(nextVideo);
        return;
      }
    }
    const idx = activePlaylist.findIndex((v) => v.id === currentVideo?.id);
    const nextIdx = idx === -1 ? 0 : (idx + 1) % activePlaylist.length;
    setCurrentVideoId(activePlaylist[nextIdx].id);
  }, [
    activePlaylist,
    currentVideo,
    activeYouTubePlaylist,
    isYouTubePlaylistShuffled,
    handleRecordYouTubeWatch
  ]);

  const handleSelectYouTubeVideo = useCallback(
    (video, playlistContext = null) => {
      setActiveCustomVideo(video);
      setCurrentVideoId(video.id);
      if (playlistContext && Array.isArray(playlistContext.items) && playlistContext.items.length > 0) {
        setActiveYouTubePlaylist(playlistContext);
      } else {
        setActiveYouTubePlaylist(null);
      }
      handleRecordYouTubeWatch(video);
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [handleRecordYouTubeWatch]
  );

  const handleSelectVideo = useCallback(
    (video) => {
      if (video?.isYouTube || String(video?.id || "").startsWith("yt_")) {
        handleSelectYouTubeVideo(video, null);
        if (currentPage !== "youtube" && currentPage !== "shorts" && !isSidePlayer) {
          setCurrentPage("youtube");
        }
        return;
      }
      setActiveYouTubePlaylist(null);
      setCurrentVideoId(video.id);
      if (currentPage !== "home" && !isSidePlayer) {
        setCurrentPage("home");
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (
        !isSidePlayer &&
        (isTheaterMode || viewMode === "mobile" || window.innerWidth <= 1024)
      ) {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    },
    [currentPage, isSidePlayer, isTheaterMode, viewMode, handleSelectYouTubeVideo]
  );

  const updateSidePlayerPrefs = useCallback((updater) => {
    setSidePlayerPrefs((prev) => {
      const next =
        typeof updater === "function" ? updater(prev) : { ...prev, ...updater };
      writeJSON(SIDE_PLAYER_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const toggleTheaterMode = useCallback(() => {
    setIsTheaterMode((prev) => {
      const next = !prev;
      if (next) setIsSidePlayer(false);
      return next;
    });
  }, []);

  const toggleSidePlayer = useCallback(() => {
    setIsSidePlayer((prev) => {
      const next = !prev;
      if (next) setIsTheaterMode(false);
      return next;
    });
  }, []);

  const handleTimeUpdate = useCallback((videoId, time, duration, options = {}) => {
    if (!videoId || !Number.isFinite(time) || time < 0) return;

    setWatchProgress((prev) => {
      const prevEntry = prev[videoId];
      const validDuration =
        Number.isFinite(duration) && duration > 0
          ? duration
          : prevEntry?.duration || 0;
      const isCompleted = Boolean(
        options.completed ||
        (validDuration > 0 && time >= Math.max(0, validDuration - 1.5))
      );

      const isGenuineWatch =
        !options.metadataOnly ||
        time > 0 ||
        isCompleted ||
        Boolean(options.played);

      const nextEntry = {
        time: Math.max(0, time),
        duration: validDuration,
        completed: isCompleted,
        watched: isGenuineWatch ? true : Boolean(prevEntry?.watched),
        hiddenFromHistory: isGenuineWatch
          ? false
          : Boolean(prevEntry?.hiddenFromHistory),
        updatedAt: isGenuineWatch ? Date.now() : prevEntry?.updatedAt || 0
      };
      // Only a real change bumps modifiedAt (sync conflict resolution), so a stale device
      // re-reporting the same position can't override a newer one from another device.
      const changed = progressEntryChanged(prevEntry, nextEntry);
      nextEntry.modifiedAt = changed ? Date.now() : prevEntry.modifiedAt || 0;

      const updated = {
        ...prev,
        [videoId]: nextEntry
      };

      writeJSON(STORAGE_KEY, updated);
      if (changed) syncStore.touchProgress();

      // Avoid excessive React re-renders during smooth playback unless second changed or forced
      if (
        !options.force &&
        prevEntry &&
        Math.floor(prevEntry.time || 0) === Math.floor(nextEntry.time) &&
        Math.floor(prevEntry.duration || 0) === Math.floor(nextEntry.duration) &&
        Boolean(prevEntry.completed) === isCompleted &&
        Boolean(prevEntry.watched) === nextEntry.watched &&
        Boolean(prevEntry.hiddenFromHistory) === nextEntry.hiddenFromHistory
      ) {
        return prev;
      }

      return updated;
    });
  }, []);

  const handleResetProgress = useCallback((videoId) => {
    if (!videoId) return;
    setWatchProgress((prev) => {
      const prevEntry = prev[videoId];
      const updated = {
        ...prev,
        [videoId]: {
          time: 0,
          duration: prevEntry?.duration || 0,
          completed: false,
          watched: true,
          hiddenFromHistory: false,
          updatedAt: Date.now(),
          modifiedAt: Date.now()
        }
      };
      writeJSON(STORAGE_KEY, updated);
      syncStore.touchProgress();
      return updated;
    });
  }, []);

  const handleRemoveFromHistory = useCallback(
    (videoId) => {
      if (!videoId) return;
      if (String(videoId).startsWith("yt_")) {
        handleRemoveYouTubeHistoryItem(videoId);
      }
      setWatchProgress((prev) => {
        const prevEntry = prev[videoId];
        const updated = {
          ...prev,
          [videoId]: {
            time: 0,
            duration: prevEntry?.duration || 0,
            completed: false,
            watched: false,
            hiddenFromHistory: true,
            updatedAt: 0,
            modifiedAt: Date.now()
          }
        };
        writeJSON(STORAGE_KEY, updated);
        syncStore.touchProgress();
        return updated;
      });
    },
    [handleRemoveYouTubeHistoryItem]
  );

  const handleClearHistory = useCallback(() => {
    handleClearYouTubeHistory("all");
    setWatchProgress((prev) => {
      // Every entry becomes a hidden tombstone (rather than being dropped) so the server copy,
      // which never deletes by omission, gets cleared too.
      const updated = {};
      const now = Date.now();
      for (const [id, entry] of Object.entries(prev)) {
        updated[id] = {
          time: 0,
          duration: entry?.duration > 0 ? entry.duration : 0,
          completed: false,
          watched: false,
          hiddenFromHistory: true,
          updatedAt: 0,
          modifiedAt: now
        };
      }
      writeJSON(STORAGE_KEY, updated);
      syncStore.touchProgress();
      return updated;
    });
  }, [handleClearYouTubeHistory]);

  const handleToggleFavorite = useCallback((videoId) => {
    if (!videoId) return;
    setFavorites((prev) => {
      const next = { ...prev };
      if (next[videoId]) {
        delete next[videoId];
      } else {
        next[videoId] = { addedAt: Date.now() };
      }
      writeJSON(FAVORITES_STORAGE_KEY, next);
      syncStore.touch("favorites");
      return next;
    });
  }, []);

  const handleClearFavorites = useCallback(() => {
    setFavorites({});
    // Written as {} (not removed) so the cleared state syncs.
    writeJSON(FAVORITES_STORAGE_KEY, {});
    syncStore.touch("favorites");
  }, []);

  const handleColorThemeChange = useCallback((nextColorTheme) => {
    setColorTheme(nextColorTheme);
    syncStore.touch("colorTheme");
  }, []);

  // Back on the tab (or the app on a phone): pick up changes made on other devices.
  useEffect(() => {
    const handleVisible = () => {
      if (document.visibilityState !== "visible") return;
      syncStore.pull().then((changed) => {
        if (!changed) return;
        setWatchProgress(loadSavedWatchProgress());
        setFavorites(loadSavedFavorites());
        setTheme((prev) => readString(THEME_STORAGE_KEY) || prev);
        setColorTheme((prev) => readString(COLOR_THEME_STORAGE_KEY) || prev);
      });
    };
    document.addEventListener("visibilitychange", handleVisible);
    return () => document.removeEventListener("visibilitychange", handleVisible);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    writeString(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-color-theme", colorTheme);
    writeString(COLOR_THEME_STORAGE_KEY, colorTheme);

    const current =
      COLOR_THEMES.find((c) => c.id === colorTheme) || COLOR_THEMES[0];
    const hex = theme === "dark" ? current.darkColor : current.color;
    const metaTheme = document.querySelector("meta[name='theme-color']");
    if (metaTheme) {
      metaTheme.setAttribute("content", hex);
    }
  }, [colorTheme, theme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-view-mode", viewMode);
  }, [viewMode]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(max-width: 768px)");
    const handleMediaChange = (e) => {
      if (!hasManualViewOverrideRef.current) {
        const nextMode = e.matches ? "mobile" : "desktop";
        setViewMode(nextMode);
      }
    };
    if (mq.addEventListener) {
      mq.addEventListener("change", handleMediaChange);
      return () => mq.removeEventListener("change", handleMediaChange);
    }
  }, []);

  const handleViewModeChange = useCallback((nextMode) => {
    if (nextMode !== "mobile" && nextMode !== "desktop") return;
    hasManualViewOverrideRef.current = true;
    setViewMode(nextMode);
    if (nextMode === "mobile") {
      setIsTheaterMode(false);
    }
    writeString(VIEW_MODE_STORAGE_KEY, nextMode);
  }, []);

  const toggleViewMode = useCallback(() => {
    setViewMode((prev) => {
      const next = prev === "mobile" ? "desktop" : "mobile";
      hasManualViewOverrideRef.current = true;
      if (next === "mobile") {
        setIsTheaterMode(false);
      }
      writeString(VIEW_MODE_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "light" ? "dark" : "light"));
    syncStore.touch("theme");
  }, []);

  // Keyboard shortcuts: 'T' for Theater Mode, 'S' for Side Player, 'M' for Mobile/Desktop View when not typing in inputs
  useEffect(() => {
    const handleKeyDown = (e) => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "t" && currentPage === "home" && viewMode !== "mobile") {
        toggleTheaterMode();
      } else if (key === "s") {
        toggleSidePlayer();
      } else if (key === "m") {
        toggleViewMode();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleTheaterMode, toggleSidePlayer, toggleViewMode, currentPage, viewMode]);

  const isPlayerHidden =
    currentPage !== "home" &&
    !isSidePlayer &&
    !((currentPage === "youtube" || currentPage === "shorts") && activeCustomVideo);

  const shortsPosition = useMemo(() => {
    if (
      !currentVideo?.isShort ||
      !activeYouTubePlaylist?.isShortsFeed ||
      !Array.isArray(activeYouTubePlaylist.items) ||
      activeYouTubePlaylist.items.length === 0
    ) {
      return null;
    }
    const rawId = String(currentVideo.ytId || currentVideo.id || "").replace(/^yt_/, "");
    const idx = activeYouTubePlaylist.items.findIndex(
      (item) => String(item.id || "").replace(/^yt_/, "") === rawId
    );
    return {
      index: idx >= 0 ? idx : 0,
      total: activeYouTubePlaylist.items.length,
      feedTitle: activeYouTubePlaylist.title || "Shorts Feed"
    };
  }, [currentVideo, activeYouTubePlaylist]);

  // Background prefetch the next 2 Shorts in the active queue so scrolling to the next Short is instant
  useEffect(() => {
    if (
      !currentVideo?.isShort ||
      !activeYouTubePlaylist?.isShortsFeed ||
      !Array.isArray(activeYouTubePlaylist.items) ||
      activeYouTubePlaylist.items.length < 2
    ) {
      return;
    }
    const items = activeYouTubePlaylist.items;
    const rawId = String(currentVideo.ytId || currentVideo.id || "").replace(/^yt_/, "");
    const idx = items.findIndex((item) => String(item.id || "").replace(/^yt_/, "") === rawId);
    if (idx === -1) return;

    const upcomingIds = [];
    for (let offset = 1; offset <= 2; offset++) {
      const nextItem = items[(idx + offset) % items.length];
      const nextId = String(nextItem?.id || "").replace(/^yt_/, "");
      if (nextId && nextId !== rawId && !upcomingIds.includes(nextId)) {
        upcomingIds.push(nextId);
      }
    }
    if (upcomingIds.length === 0) return;

    fetch(`/api/youtube/prefetch?ids=${encodeURIComponent(upcomingIds.join(","))}&quality=480`).catch(
      () => {}
    );
  }, [currentVideo?.id, currentVideo?.isShort, currentVideo?.ytId, activeYouTubePlaylist]);

  return (
    <div className={`app-shell view-mode-${viewMode}`}>
      <Navbar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        isTheaterMode={isTheaterMode}
        onToggleTheater={toggleTheaterMode}
        isSidePlayer={isSidePlayer}
        onToggleSidePlayer={toggleSidePlayer}
        viewMode={viewMode}
        theme={theme}
        onToggleTheme={toggleTheme}
        colorTheme={colorTheme}
        onColorThemeChange={handleColorThemeChange}
        onToggleMenu={() => setIsMenuOpen((prev) => !prev)}
        currentPage={currentPage}
        onNavigate={setCurrentPage}
        auth={auth}
        onLogout={handleLogout}
      />

      <SideMenu
        isOpen={isMenuOpen}
        onClose={() => setIsMenuOpen(false)}
        currentPage={currentPage}
        onNavigate={setCurrentPage}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
        theme={theme}
        colorTheme={colorTheme}
        onColorThemeChange={handleColorThemeChange}
        totalVideosCount={VIDEO_LIBRARY.length}
        historyCount={historyItems.length}
        favoritesCount={favoriteItems.length}
        inProgressCount={inProgressCount}
        completedCount={completedCount}
        visitors={visitors}
        selfVisitor={selfVisitor}
        onVisitorNameChange={handleVisitorNameChange}
        auth={auth}
        onLogout={handleLogout}
      />

      <main
        className={`container ${viewMode === "mobile" ? "mobile-container" : ""} ${currentPage !== "home"
            ? "subpage-mode"
            : `${isTheaterMode ? "theater-mode" : ""} ${isSidePlayer ? "side-player-active" : ""
            }`
          }`}
      >
        {authNotification && (
          <div className="youtube-auth-notice-banner" role="alert">
            <span>{authNotification}</span>
            <button
              type="button"
              className="youtube-notice-close-btn"
              onClick={() => setAuthNotification(null)}
              aria-label="Dismiss notice"
            >
              ✕
            </button>
          </div>
        )}

        <VideoPlayer
          video={currentVideo}
          onEnded={handleNext}
          onPrev={handlePrev}
          onNext={handleNext}
          savedTime={watchProgress[currentVideo?.id]?.time || 0}
          savedProgress={watchProgress[currentVideo?.id]}
          onTimeUpdate={handleTimeUpdate}
          onResetProgress={handleResetProgress}
          isFavorited={Boolean(favorites[currentVideo?.id])}
          onToggleFavorite={handleToggleFavorite}
          isHidden={isPlayerHidden}
          isSidePlayer={isSidePlayer}
          onToggleSidePlayer={toggleSidePlayer}
          sidePlayerPrefs={sidePlayerPrefs}
          onUpdateSidePlayerPrefs={updateSidePlayerPrefs}
          viewMode={viewMode}
          onToggleTheater={toggleTheaterMode}
          shortsPosition={shortsPosition}
          onClose={
            activeCustomVideo
              ? () => {
                setActiveCustomVideo(null);
                setActiveYouTubePlaylist(null);
              }
              : undefined
          }
        />

        {currentPage === "home" && (
          <VideoGrid
            videos={filteredVideos}
            allVideosCount={VIDEO_LIBRARY.length}
            courses={courses}
            sections={sections}
            selectedCourse={selectedCourse}
            selectedSection={selectedSection}
            filterWatchStatus={filterWatchStatus}
            onCourseChange={handleCourseChange}
            onSectionChange={setSelectedSection}
            onFilterWatchStatusChange={setFilterWatchStatus}
            currentVideoId={currentVideo?.id}
            watchProgress={watchProgress}
            favorites={favorites}
            onToggleFavorite={handleToggleFavorite}
            onSelectVideo={handleSelectVideo}
            onResetProgress={handleResetProgress}
          />
        )}

        {currentPage === "history" && (
          <HistoryPage
            historyItems={historyItems}
            watchProgress={watchProgress}
            favorites={favorites}
            currentVideoId={currentVideo?.id}
            onSelectVideo={handleSelectVideo}
            onToggleFavorite={handleToggleFavorite}
            onRemoveFromHistory={handleRemoveFromHistory}
            onClearHistory={handleClearHistory}
            onNavigateHome={() => setCurrentPage("home")}
            youtubeHistorySync={youtubeHistorySync}
            onSyncYouTubeHistory={handleSyncYouTubeHistory}
            onOpenYouTubeHistorySync={() => {
              setYoutubeInitialTab("recent");
              setCurrentPage("youtube");
            }}
          />
        )}

        {currentPage === "favorites" && (
          <FavoritesPage
            favoriteItems={favoriteItems}
            watchProgress={watchProgress}
            currentVideoId={currentVideo?.id}
            onSelectVideo={handleSelectVideo}
            onToggleFavorite={handleToggleFavorite}
            onClearFavorites={handleClearFavorites}
            onNavigateHome={() => setCurrentPage("home")}
          />
        )}

        {currentPage === "youtube" && (
          <YouTubePage
            onSelectYouTubeVideo={handleSelectYouTubeVideo}
            currentVideoId={currentVideo?.id}
            favorites={favorites}
            onToggleFavorite={handleToggleFavorite}
            auth={auth}
            initialTab={youtubeInitialTab}
            onConsumeInitialTab={() => setYoutubeInitialTab(null)}
            youtubeHistory={youtubeHistory}
            youtubeHistorySync={youtubeHistorySync}
            onSyncYouTubeHistory={handleSyncYouTubeHistory}
            onImportYouTubeHistory={handleImportYouTubeHistory}
            onSaveYouTubeCookies={handleSaveYouTubeCookies}
            onClearYouTubeCookies={handleClearYouTubeCookies}
            onRemoveYouTubeHistoryItem={handleRemoveYouTubeHistoryItem}
            onClearYouTubeHistory={handleClearYouTubeHistory}
            activePlaylist={activeYouTubePlaylist}
            isPlaylistShuffled={isYouTubePlaylistShuffled}
            onTogglePlaylistShuffle={() => setIsYouTubePlaylistShuffled((prev) => !prev)}
            onClearActivePlaylist={() => setActiveYouTubePlaylist(null)}
            onPrevPlaylistVideo={handlePrev}
            onNextPlaylistVideo={handleNext}
          />
        )}

        {currentPage === "shorts" && (
          <ShortsPage
            onSelectShort={handleSelectYouTubeVideo}
            currentVideoId={currentVideo?.id}
            favorites={favorites}
            onToggleFavorite={handleToggleFavorite}
            auth={auth}
            youtubeHistory={youtubeHistory}
          />
        )}

        {/* Stays mounted once opened, so uploads keep running while you browse. */}
        {uploadPageOpened && (
          <div hidden={currentPage !== "upload"}>
            <UploadPage
              keyStorageKey={UPLOAD_KEY_STORAGE_KEY}
              googleAuth={auth}
              onNavigateHome={() => setCurrentPage("home")}
            />
          </div>
        )}
      </main>

      {viewMode === "mobile" && (
        <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
          <button
            type="button"
            className={`mobile-nav-item ${currentPage === "youtube" ? "active" : ""}`}
            onClick={() => setCurrentPage("youtube")}
          >
            <span className="mobile-nav-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill={currentPage === "youtube" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.33z" />
                <polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02" fill="currentColor" />
              </svg>
            </span>
            <span className="mobile-nav-label">YouTube</span>
          </button>

          <button
            type="button"
            className={`mobile-nav-item ${currentPage === "shorts" ? "active" : ""}`}
            onClick={() => setCurrentPage("shorts")}
          >
            <span className="mobile-nav-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill={currentPage === "shorts" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="5" y="2" width="14" height="20" rx="3" />
                <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" />
              </svg>
            </span>
            <span className="mobile-nav-label">Shorts</span>
          </button>

          <button
            type="button"
            className={`mobile-nav-item ${currentPage === "home" ? "active" : ""}`}
            onClick={() => setCurrentPage("home")}
          >
            <span className="mobile-nav-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1V9.5z" />
              </svg>
            </span>
            <span className="mobile-nav-label">Library</span>
          </button>

          <button
            type="button"
            className={`mobile-nav-item ${currentPage === "history" ? "active" : ""}`}
            onClick={() => setCurrentPage("history")}
          >
            <span className="mobile-nav-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                <polyline points="3 3 3 8 8 8" />
                <polyline points="12 7 12 12 15.5 14" />
              </svg>
              {historyItems.length > 0 && (
                <span className="mobile-nav-badge">{historyItems.length}</span>
              )}
            </span>
            <span className="mobile-nav-label">History</span>
          </button>

          <button
            type="button"
            className={`mobile-nav-item ${currentPage === "favorites" ? "active" : ""}`}
            onClick={() => setCurrentPage("favorites")}
          >
            <span className="mobile-nav-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill={currentPage === "favorites" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
              </svg>
              {favoriteItems.length > 0 && (
                <span className="mobile-nav-badge">{favoriteItems.length}</span>
              )}
            </span>
            <span className="mobile-nav-label">Favorites</span>
          </button>

          <button
            type="button"
            className={`mobile-nav-item ${isMenuOpen ? "active" : ""}`}
            onClick={() => setIsMenuOpen((prev) => !prev)}
          >
            <span className="mobile-nav-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </span>
            <span className="mobile-nav-label">Menu</span>
          </button>
        </nav>
      )}
    </div>
  );
}
