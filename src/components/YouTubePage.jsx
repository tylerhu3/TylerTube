import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { formatDuration, formatViewCount } from "../utils/format";
import { readJSON, writeJSON } from "../lib/storage";
import { getGoogleLoginUrl } from "../lib/auth";
import {
  YOUTUBE_MOOD_SECTIONS,
  pickRandomSearch,
  pickRandomSuggestedSearches,
  pickQueryForSection,
  pickInitialShelves
} from "../data/youtubeDiscovery";
import {
  extractPlaylistIdFromInput,
  createCustomPlaylist,
  renameCustomPlaylist,
  deleteCustomPlaylist,
  addVideoToPlaylist,
  removeVideoFromPlaylist,
  moveVideoInPlaylist,
  toPlayableYouTubeVideo
} from "../lib/youtubePlaylists";
import YouTubePlaylistsSection, {
  ActivePlaylistBar,
  AddToPlaylistModal
} from "./YouTubePlaylistsSection";

const RECENT_SEARCHES_KEY = "tylertube_youtube_recent_searches";
const SAVED_META_KEY = "tylertube_youtube_saved_meta";
const CUSTOM_PLAYLISTS_KEY = "tylertube_youtube_playlists";
const MAX_RECENT_SEARCHES = 8;
const INITIAL_SHELF_COUNT = 3;

const SUPPORTED_BROWSERS = [
  { id: "chrome", label: "Chrome" },
  { id: "safari", label: "Safari" },
  { id: "firefox", label: "Firefox" },
  { id: "brave", label: "Brave" },
  { id: "edge", label: "Edge" },
  { id: "opera", label: "Opera" }
];

function formatRelativeWatchTime(timestamp) {
  if (!timestamp) return "";
  const diffMs = Date.now() - timestamp;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined
  });
}

function isLikelyYouTubeUrl(str) {
  const s = String(str || "").trim().toLowerCase();
  return (
    s.includes("youtube.com") ||
    s.includes("youtu.be") ||
    s.startsWith("yt:") ||
    /^[a-zA-Z0-9_-]{11}$/.test(s)
  );
}

function VideoCard({
  item,
  isPlaying,
  isFav,
  onSelect,
  onToggleFavorite,
  onAddToPlaylist,
  onRemove,
  showSourceBadge = false,
  compact = false
}) {
  const viewsLabel = formatViewCount(item.viewCount);
  const watchedLabel = showSourceBadge ? formatRelativeWatchTime(item.watchedAt) : "";
  const isFromYouTube = Boolean(item.watchedOnYouTube || item.source === "youtube");

  return (
    <div
      className={`youtube-card ${compact ? "youtube-card-compact" : ""} ${isPlaying ? "active-playing" : ""
        }`}
      onClick={() => onSelect(item)}
    >
      <div className="youtube-card-thumb-wrap">
        <img
          src={item.thumbnail}
          alt={item.title}
          className="youtube-card-thumb"
          loading="lazy"
        />
        {item.duration > 0 && (
          <span className="youtube-card-duration">
            {formatDuration(item.duration)}
          </span>
        )}
        {isPlaying && (
          <div className="youtube-card-playing-badge">
            <span>▶ PLAYING</span>
          </div>
        )}
      </div>

      <div className="youtube-card-content">
        <h3 className="youtube-card-title" title={item.title}>
          {item.title}
        </h3>
        <div className="youtube-card-author">
          <span>{item.author}</span>
          {viewsLabel && (
            <>
              <span aria-hidden="true">·</span>
              <span>{viewsLabel}</span>
            </>
          )}
          {watchedLabel && (
            <>
              <span aria-hidden="true">·</span>
              <span>{watchedLabel}</span>
            </>
          )}
        </div>

        <div className="youtube-card-footer">
          {showSourceBadge ? (
            <span
              className={`youtube-card-badge ${isFromYouTube ? "source-youtube" : "source-tylertube"
                }`}
            >
              {isFromYouTube ? "Watched on YouTube" : "Watched on TylerTube"}
            </span>
          ) : (
            <span className="youtube-card-badge">WebCodecs Stream</span>
          )}
          <div className="youtube-card-footer-actions">
            {onAddToPlaylist && (
              <button
                type="button"
                className="youtube-fav-btn youtube-add-playlist-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onAddToPlaylist(item);
                }}
                title="Save to playlist"
                aria-label="Save to playlist"
              >
                ＋
              </button>
            )}
            {onRemove && (
              <button
                type="button"
                className="youtube-fav-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(item.id);
                }}
                title="Remove from watch history"
                aria-label="Remove from watch history"
              >
                ✕
              </button>
            )}
            <button
              type="button"
              className={`youtube-fav-btn ${isFav ? "favorited" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite(item);
              }}
              title={isFav ? "Remove from Favorites" : "Add to Favorites"}
              aria-label="Toggle favorite"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill={isFav ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DiscoveryShelf({
  shelf,
  state,
  currentVideoId,
  favorites,
  onSelect,
  onToggleFavorite,
  onAddToPlaylist,
  onReroll,
  onExploreAll
}) {
  const trackRef = useRef(null);

  const scrollTrack = (direction) => {
    if (!trackRef.current) return;
    const delta = Math.max(300, trackRef.current.clientWidth * 0.75);
    trackRef.current.scrollBy({
      left: direction === "left" ? -delta : delta,
      behavior: "smooth"
    });
  };

  return (
    <section
      className="youtube-shelf"
      style={{ "--shelf-accent": shelf.accent }}
    >
      <div className="youtube-shelf-header">
        <div className="youtube-shelf-heading">
          <span className="youtube-shelf-emoji" aria-hidden="true">
            {shelf.emoji}
          </span>
          <div>
            <div className="youtube-shelf-title-row">
              <h3 className="youtube-shelf-title">{shelf.title}</h3>
              <span className="youtube-shelf-query-pill" title={shelf.activeQuery}>
                “{shelf.activeQuery}”
              </span>
            </div>
            <p className="youtube-shelf-subtitle">{shelf.subtitle}</p>
          </div>
        </div>

        <div className="youtube-shelf-actions">
          <button
            type="button"
            className="youtube-shelf-btn"
            onClick={() => onReroll(shelf.id)}
            disabled={state?.loading}
            title="Spin a fresh random search in this section"
          >
            🎲 Reroll
          </button>
          <button
            type="button"
            className="youtube-shelf-btn"
            onClick={() => onExploreAll(shelf)}
            title="Open full search results for this topic"
          >
            See all →
          </button>
          <div className="youtube-shelf-arrows">
            <button
              type="button"
              className="youtube-shelf-arrow-btn"
              onClick={() => scrollTrack("left")}
              aria-label={`Scroll ${shelf.title} left`}
            >
              ‹
            </button>
            <button
              type="button"
              className="youtube-shelf-arrow-btn"
              onClick={() => scrollTrack("right")}
              aria-label={`Scroll ${shelf.title} right`}
            >
              ›
            </button>
          </div>
        </div>
      </div>

      {state?.loading && (
        <div className="youtube-shelf-track">
          {Array.from({ length: 4 }).map((_, idx) => (
            <div key={idx} className="youtube-skeleton-card">
              <div className="youtube-skeleton-thumb" />
              <div className="youtube-skeleton-body">
                <div className="youtube-skeleton-line wide" />
                <div className="youtube-skeleton-line short" />
              </div>
            </div>
          ))}
        </div>
      )}

      {!state?.loading && state?.error && (
        <div className="youtube-shelf-error">
          <span>{state.error}</span>
          <button
            type="button"
            className="youtube-shelf-btn"
            onClick={() => onReroll(shelf.id, true)}
          >
            Retry
          </button>
        </div>
      )}

      {!state?.loading && !state?.error && state?.items?.length > 0 && (
        <div className="youtube-shelf-track" ref={trackRef}>
          {state.items.map((item) => {
            const videoId = `yt_${item.id}`;
            return (
              <VideoCard
                key={item.id}
                item={item}
                compact
                isPlaying={currentVideoId === videoId}
                isFav={Boolean(favorites[videoId])}
                onSelect={onSelect}
                onToggleFavorite={onToggleFavorite}
                onAddToPlaylist={onAddToPlaylist}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function YouTubePage({
  onSelectYouTubeVideo,
  currentVideoId,
  favorites = {},
  onToggleFavorite,
  auth = null,
  initialTab = null,
  onConsumeInitialTab,
  youtubeHistory = [],
  youtubeHistorySync = {},
  onSyncYouTubeHistory,
  onImportYouTubeHistory,
  onSaveYouTubeCookies,
  onClearYouTubeCookies,
  onRemoveYouTubeHistoryItem,
  onClearYouTubeHistory,
  activePlaylist = null,
  isPlaylistShuffled = false,
  onTogglePlaylistShuffle,
  onClearActivePlaylist,
  onPrevPlaylistVideo,
  onNextPlaylistVideo
}) {
  // Landing page always starts with a completely random creative search
  const initialRandomRef = useRef(null);
  if (initialRandomRef.current === null) {
    initialRandomRef.current = pickRandomSearch();
  }

  const [activeTab, setActiveTab] = useState(initialTab || "explore"); // "explore" | "subscriptions" | "liked" | "saved" | "recent"
  const [query, setQuery] = useState(initialRandomRef.current);
  const [activeSearchQuery, setActiveSearchQuery] = useState(initialRandomRef.current);
  const [searchContextLabel, setSearchContextLabel] = useState("🎲 Random Landing Pick");
  const [suggestedTopics, setSuggestedTopics] = useState(() =>
    pickRandomSuggestedSearches(9, [initialRandomRef.current])
  );
  const [recentSearches, setRecentSearches] = useState(() => {
    const saved = readJSON(RECENT_SEARCHES_KEY, []);
    return Array.isArray(saved) ? saved : [];
  });
  const [savedVideoMeta, setSavedVideoMeta] = useState(() => {
    const saved = readJSON(SAVED_META_KEY, {});
    return saved && typeof saved === "object" ? saved : {};
  });

  // YouTube Playlists state (custom local playlists + signed-in YouTube playlists + opened playlist)
  const [customPlaylists, setCustomPlaylists] = useState(() => {
    const saved = readJSON(CUSTOM_PLAYLISTS_KEY, []);
    return Array.isArray(saved) ? saved : [];
  });
  const [accountPlaylists, setAccountPlaylists] = useState([]);
  const [accountPlaylistsLoading, setAccountPlaylistsLoading] = useState(false);
  const [accountPlaylistsError, setAccountPlaylistsError] = useState(null);
  const [openedRemotePlaylist, setOpenedRemotePlaylist] = useState(null);
  const [openedCustomPlaylistId, setOpenedCustomPlaylistId] = useState(null);
  const [openedPlaylistLoading, setOpenedPlaylistLoading] = useState(false);
  const [openedPlaylistError, setOpenedPlaylistError] = useState(null);
  const [playlistPickerVideo, setPlaylistPickerVideo] = useState(null);

  // YouTube Watch History sync & filter state
  const [historySourceFilter, setHistorySourceFilter] = useState("all"); // "all" | "youtube" | "tylertube"
  const [historySyncOpen, setHistorySyncOpen] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyStatus, setHistoryStatus] = useState(null);
  const [selectedBrowser, setSelectedBrowser] = useState(
    () => youtubeHistorySync?.browser || "chrome"
  );
  const [cookiesText, setCookiesText] = useState("");
  const takeoutInputRef = useRef(null);
  const cookiesInputRef = useRef(null);

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
      if (initialTab === "recent") {
        setHistorySyncOpen(true);
      }
      onConsumeInitialTab?.();
    }
  }, [initialTab, onConsumeInitialTab]);

  const recentVideos = youtubeHistory;

  const [results, setResults] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isUrlDirectPlaying, setIsUrlDirectPlaying] = useState(false);

  // Personalized feed state
  const [feedItems, setFeedItems] = useState([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedError, setFeedError] = useState(null);

  // Live Discovery Shelves state
  const [shelves, setShelves] = useState(() => pickInitialShelves(INITIAL_SHELF_COUNT));
  const [shelfData, setShelfData] = useState({});
  const resultsSectionRef = useRef(null);

  const recordRecentSearch = useCallback((q) => {
    const clean = String(q || "").trim();
    if (!clean || isLikelyYouTubeUrl(clean)) return;
    setRecentSearches((prev) => {
      const next = [
        clean,
        ...prev.filter((item) => item.toLowerCase() !== clean.toLowerCase())
      ].slice(0, MAX_RECENT_SEARCHES);
      writeJSON(RECENT_SEARCHES_KEY, next);
      return next;
    });
  }, []);

  const handleRunLiveSync = useCallback(
    async (browserOverride = "") => {
      if (!onSyncYouTubeHistory) return;
      setHistoryBusy(true);
      setHistoryStatus(null);
      try {
        const res = await onSyncYouTubeHistory({ browser: browserOverride });
        const count = res?.syncedCount ?? res?.items?.length ?? 0;
        setHistoryStatus({
          type: "success",
          text:
            count > 0
              ? `Synced ${count} recently watched videos from YouTube.`
              : "Connected to YouTube, but no watch history items were returned."
        });
      } catch (err) {
        setHistoryStatus({
          type: "error",
          text: err.message || "Could not sync YouTube watch history."
        });
      } finally {
        setHistoryBusy(false);
      }
    },
    [onSyncYouTubeHistory]
  );

  const handleTakeoutFileChange = useCallback(
    async (e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file || !onImportYouTubeHistory) return;
      setHistoryBusy(true);
      setHistoryStatus(null);
      try {
        const text = await file.text();
        const res = await onImportYouTubeHistory(text, file.name);
        setHistoryStatus({
          type: "success",
          text: `Imported ${res?.importedCount || 0} YouTube videos from ${file.name}.`
        });
      } catch (err) {
        setHistoryStatus({
          type: "error",
          text: err.message || "Could not parse Google Takeout file."
        });
      } finally {
        setHistoryBusy(false);
      }
    },
    [onImportYouTubeHistory]
  );

  const handleSaveCookiesAndSync = useCallback(
    async (rawText) => {
      if (!onSaveYouTubeCookies) return;
      setHistoryBusy(true);
      setHistoryStatus(null);
      try {
        await onSaveYouTubeCookies(rawText);
        setCookiesText("");
        if (onSyncYouTubeHistory) {
          const res = await onSyncYouTubeHistory();
          setHistoryStatus({
            type: "success",
            text: `Cookies saved & synced ${res?.syncedCount || 0} videos from YouTube.`
          });
        } else {
          setHistoryStatus({
            type: "success",
            text: "YouTube cookies saved."
          });
        }
      } catch (err) {
        setHistoryStatus({
          type: "error",
          text: err.message || "Could not save cookies."
        });
      } finally {
        setHistoryBusy(false);
      }
    },
    [onSaveYouTubeCookies, onSyncYouTubeHistory]
  );

  const handleCookiesFileChange = useCallback(
    async (e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      const text = await file.text();
      await handleSaveCookiesAndSync(text);
    },
    [handleSaveCookiesAndSync]
  );

  const handleDisconnectCookies = useCallback(async () => {
    if (!onClearYouTubeCookies) return;
    setHistoryBusy(true);
    setHistoryStatus(null);
    try {
      await onClearYouTubeCookies();
      setHistoryStatus({
        type: "success",
        text: "Disconnected saved YouTube cookies."
      });
    } catch (err) {
      setHistoryStatus({
        type: "error",
        text: err.message || "Failed to disconnect cookies."
      });
    } finally {
      setHistoryBusy(false);
    }
  }, [onClearYouTubeCookies]);

  const youtubeOnlyCount = useMemo(
    () => recentVideos.filter((v) => v.watchedOnYouTube || v.source === "youtube").length,
    [recentVideos]
  );
  const tylertubeOnlyCount = useMemo(
    () => recentVideos.filter((v) => !v.watchedOnYouTube && v.source === "tylertube").length,
    [recentVideos]
  );
  const filteredRecentVideos = useMemo(() => {
    if (historySourceFilter === "youtube") {
      return recentVideos.filter((v) => v.watchedOnYouTube || v.source === "youtube");
    }
    if (historySourceFilter === "tylertube") {
      return recentVideos.filter((v) => !v.watchedOnYouTube && v.source === "tylertube");
    }
    return recentVideos;
  }, [recentVideos, historySourceFilter]);

  const handleToggleFavoriteItem = useCallback(
    (item) => {
      if (!item?.id) return;
      const videoId = `yt_${item.id}`;
      setSavedVideoMeta((prev) => {
        const next = {
          ...prev,
          [videoId]: {
            id: item.id,
            title: item.title || "YouTube Video",
            author: item.author || "YouTube",
            duration: Number(item.duration) || 0,
            thumbnail:
              item.thumbnail || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
            viewCount: Number(item.viewCount) || 0
          }
        };
        writeJSON(SAVED_META_KEY, next);
        return next;
      });
      onToggleFavorite?.(videoId);
    },
    [onToggleFavorite]
  );

  const savedYouTubeItems = useMemo(() => {
    const items = [];
    for (const [videoId, favEntry] of Object.entries(favorites || {})) {
      if (!videoId.startsWith("yt_") || !favEntry) continue;
      const rawId = videoId.slice(3);
      const meta =
        savedVideoMeta[videoId] ||
        recentVideos.find((v) => v.id === rawId) ||
        results.find((v) => v.id === rawId);
      items.push({
        id: rawId,
        title: meta?.title || `YouTube Video (${rawId})`,
        author: meta?.author || "YouTube",
        duration: meta?.duration || 0,
        thumbnail:
          meta?.thumbnail || `https://i.ytimg.com/vi/${rawId}/hqdefault.jpg`,
        viewCount: meta?.viewCount || 0,
        addedAt:
          typeof favEntry === "object" ? favEntry.addedAt || 0 : Number(favEntry) || 0
      });
    }
    items.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return items;
  }, [favorites, savedVideoMeta, recentVideos, results]);

  const performSearch = useCallback(
    async (searchQuery, { saveToHistory = false, contextLabel = "" } = {}) => {
      const q = String(searchQuery || "").trim();
      if (!q) return;

      setIsLoading(true);
      setError(null);
      setActiveSearchQuery(q);
      setSearchContextLabel(contextLabel);
      if (saveToHistory) {
        recordRecentSearch(q);
      }

      try {
        const res = await fetch(
          `/api/youtube/search?q=${encodeURIComponent(q)}&limit=16`
        );
        if (!res.ok) {
          const errJson = await res.json().catch(() => ({}));
          throw new Error(errJson.error || `Search failed with status ${res.status}`);
        }
        const data = await res.json();
        setResults(data.items || []);
      } catch (err) {
        setError(err.message || "Failed to search YouTube");
      } finally {
        setIsLoading(false);
      }
    },
    [recordRecentSearch]
  );

  const fetchShelfVideos = useCallback(async (shelfId, searchQuery) => {
    setShelfData((prev) => ({
      ...prev,
      [shelfId]: { ...(prev[shelfId] || {}), loading: true, error: null }
    }));

    try {
      const res = await fetch(
        `/api/youtube/search?q=${encodeURIComponent(searchQuery)}&limit=8`
      );
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Failed (${res.status})`);
      }
      const data = await res.json();
      setShelfData((prev) => ({
        ...prev,
        [shelfId]: {
          loading: false,
          error: null,
          items: data.items || []
        }
      }));
    } catch (err) {
      setShelfData((prev) => ({
        ...prev,
        [shelfId]: {
          loading: false,
          error: err.message || "Could not load section",
          items: prev[shelfId]?.items || []
        }
      }));
    }
  }, []);

  // Load initial random landing search, then hydrate initial discovery shelves
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await performSearch(initialRandomRef.current, {
        saveToHistory: false,
        contextLabel: "🎲 Random Landing Pick"
      });
      if (cancelled) return;
      // Load the initial themed shelves right after main results arrive
      for (const shelf of shelves) {
        if (cancelled) break;
        fetchShelfVideos(shelf.id, shelf.activeQuery);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch subscriptions feed
  const loadSubscriptionsFeed = useCallback(async () => {
    if (!auth?.authenticated) return;
    setFeedLoading(true);
    setFeedError(null);

    try {
      const res = await fetch("/api/youtube/feed");
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(
          errJson.error || `Failed to fetch subscriptions (${res.status})`
        );
      }
      const data = await res.json();
      setFeedItems(data.items || []);
    } catch (err) {
      setFeedError(
        err.message || "Unable to load subscriptions feed. Showing explore view."
      );
    } finally {
      setFeedLoading(false);
    }
  }, [auth]);

  // Fetch liked videos
  const loadLikedVideos = useCallback(async () => {
    if (!auth?.authenticated) return;
    setFeedLoading(true);
    setFeedError(null);

    try {
      const res = await fetch("/api/youtube/liked");
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(
          errJson.error || `Failed to fetch liked videos (${res.status})`
        );
      }
      const data = await res.json();
      setFeedItems(data.items || []);
    } catch (err) {
      setFeedError(
        err.message || "Unable to load liked videos. Showing explore view."
      );
    } finally {
      setFeedLoading(false);
    }
  }, [auth]);

  // Fetch signed-in user's YouTube playlists
  const loadAccountPlaylists = useCallback(async () => {
    if (!auth?.authenticated) return;
    setAccountPlaylistsLoading(true);
    setAccountPlaylistsError(null);

    try {
      const res = await fetch("/api/youtube/playlists");
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(
          errJson.error || `Failed to fetch playlists (${res.status})`
        );
      }
      const data = await res.json();
      setAccountPlaylists(data.items || []);
    } catch (err) {
      setAccountPlaylistsError(err.message || "Unable to load YouTube playlists.");
    } finally {
      setAccountPlaylistsLoading(false);
    }
  }, [auth]);

  const updateCustomPlaylists = useCallback((updater) => {
    setCustomPlaylists((prev) => {
      const next = updater(prev);
      writeJSON(CUSTOM_PLAYLISTS_KEY, next);
      return next;
    });
  }, []);

  const handleOpenYouTubePlaylist = useCallback(
    async (playlistInput, { source = "auto", autoPlayVideoId = null } = {}) => {
      const raw = String(playlistInput || "").trim();
      if (!raw) return;

      setActiveTab("playlists");
      setOpenedCustomPlaylistId(null);
      setOpenedRemotePlaylist(null);
      setOpenedPlaylistError(null);
      setOpenedPlaylistLoading(true);

      try {
        const qs = new URLSearchParams({ list: raw, limit: "50", source });
        const res = await fetch(`/api/youtube/playlist?${qs.toString()}`);
        if (!res.ok) {
          const errJson = await res.json().catch(() => ({}));
          throw new Error(errJson.error || `Failed to load playlist (${res.status})`);
        }
        const data = await res.json();
        setOpenedRemotePlaylist(data);

        if (autoPlayVideoId && Array.isArray(data.items) && data.items.length > 0) {
          const targetItem =
            data.items.find((v) => v.id === autoPlayVideoId) || data.items[0];
          const playable = toPlayableYouTubeVideo(targetItem);
          if (playable) {
            onSelectYouTubeVideo?.(playable, data);
          }
        }
      } catch (err) {
        setOpenedPlaylistError(err.message || "Could not load YouTube playlist.");
      } finally {
        setOpenedPlaylistLoading(false);
      }
    },
    [onSelectYouTubeVideo]
  );

  const handleOpenCustomPlaylist = useCallback((playlistId) => {
    setOpenedRemotePlaylist(null);
    setOpenedPlaylistError(null);
    setOpenedPlaylistLoading(false);
    setOpenedCustomPlaylistId(playlistId);
  }, []);

  const handleCloseOpenedPlaylist = useCallback(() => {
    setOpenedRemotePlaylist(null);
    setOpenedCustomPlaylistId(null);
    setOpenedPlaylistError(null);
    setOpenedPlaylistLoading(false);
  }, []);

  const handleCreatePlaylist = useCallback(
    (name) => {
      updateCustomPlaylists((prev) => createCustomPlaylist(prev, { name }));
    },
    [updateCustomPlaylists]
  );

  const handleRenamePlaylist = useCallback(
    (playlistId, nextTitle) => {
      updateCustomPlaylists((prev) => renameCustomPlaylist(prev, playlistId, nextTitle));
    },
    [updateCustomPlaylists]
  );

  const handleDeletePlaylist = useCallback(
    (playlistId) => {
      updateCustomPlaylists((prev) => deleteCustomPlaylist(prev, playlistId));
      if (openedCustomPlaylistId === playlistId) {
        setOpenedCustomPlaylistId(null);
      }
      if (activePlaylist?.id === playlistId) {
        onClearActivePlaylist?.();
      }
    },
    [updateCustomPlaylists, openedCustomPlaylistId, activePlaylist?.id, onClearActivePlaylist]
  );

  const handleSaveRemotePlaylist = useCallback(
    (remotePl) => {
      if (!remotePl) return;
      updateCustomPlaylists((prev) =>
        createCustomPlaylist(prev, {
          name: remotePl.title || "Saved YouTube Playlist",
          description: remotePl.description || "",
          author: remotePl.author || "YouTube",
          items: remotePl.items || [],
          sourcePlaylistId: remotePl.id || ""
        })
      );
    },
    [updateCustomPlaylists]
  );

  const handleToggleVideoInPlaylist = useCallback(
    (playlistId, video, currentlyAdded) => {
      updateCustomPlaylists((prev) =>
        currentlyAdded
          ? removeVideoFromPlaylist(prev, playlistId, video.ytId || video.id)
          : addVideoToPlaylist(prev, playlistId, video)
      );
    },
    [updateCustomPlaylists]
  );

  const handleCreateAndAddVideo = useCallback(
    (name, video) => {
      updateCustomPlaylists((prev) =>
        createCustomPlaylist(prev, { name, items: [video] })
      );
    },
    [updateCustomPlaylists]
  );

  const handleRemoveVideoFromPlaylist = useCallback(
    (playlistId, rawVideoId) => {
      updateCustomPlaylists((prev) => removeVideoFromPlaylist(prev, playlistId, rawVideoId));
    },
    [updateCustomPlaylists]
  );

  const handleMoveVideoInPlaylist = useCallback(
    (playlistId, rawVideoId, direction) => {
      updateCustomPlaylists((prev) =>
        moveVideoInPlaylist(prev, playlistId, rawVideoId, direction)
      );
    },
    [updateCustomPlaylists]
  );

  const handlePlayPlaylist = useCallback(
    (playlist, startItem = null, { shuffle = false } = {}) => {
      const items = Array.isArray(playlist?.items) ? playlist.items : [];
      if (items.length === 0) return;
      if (shuffle && !isPlaylistShuffled) {
        onTogglePlaylistShuffle?.();
      } else if (!shuffle && isPlaylistShuffled) {
        onTogglePlaylistShuffle?.();
      }
      const target = startItem || items[0];
      const playable = toPlayableYouTubeVideo(target);
      if (playable) {
        onSelectYouTubeVideo?.(playable, {
          id: playlist.id,
          title: playlist.title || "YouTube Playlist",
          items
        });
      }
    },
    [isPlaylistShuffled, onTogglePlaylistShuffle, onSelectYouTubeVideo]
  );

  const handleSelectActivePlaylistTrack = useCallback(
    (item) => {
      if (!activePlaylist) return;
      const playable = toPlayableYouTubeVideo(item);
      if (playable) {
        onSelectYouTubeVideo?.(playable, activePlaylist);
      }
    },
    [activePlaylist, onSelectYouTubeVideo]
  );

  const openedPlaylist = useMemo(() => {
    if (openedCustomPlaylistId) {
      return customPlaylists.find((pl) => pl.id === openedCustomPlaylistId) || null;
    }
    return openedRemotePlaylist;
  }, [openedCustomPlaylistId, customPlaylists, openedRemotePlaylist]);

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    setFeedError(null);
    if (tab === "subscriptions") {
      if (auth?.authenticated) loadSubscriptionsFeed();
    } else if (tab === "liked") {
      if (auth?.authenticated) loadLikedVideos();
    } else if (tab === "playlists") {
      if (auth?.authenticated) loadAccountPlaylists();
    }
  };

  const handlePlayDirectUrl = async (urlOrId) => {
    const raw = String(urlOrId || query).trim();
    if (!raw) return;

    setIsUrlDirectPlaying(true);
    setError(null);

    try {
      const res = await fetch(`/api/youtube/info?v=${encodeURIComponent(raw)}`);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || "Failed to resolve YouTube video");
      }
      const info = await res.json();
      const videoObj = {
        id: `yt_${info.id}`,
        ytId: info.id,
        title: info.title,
        duration: info.duration || 0,
        src: `yt:${info.id}`,
        poster: info.thumbnail,
        course: "YouTube",
        section: info.author || "YouTube",
        isYouTube: true
      };
      onSelectYouTubeVideo?.(videoObj);
    } catch (err) {
      setError(err.message || "Could not play YouTube URL");
    } finally {
      setIsUrlDirectPlaying(false);
    }
  };

  const detectedPlaylistId = useMemo(() => extractPlaylistIdFromInput(query), [query]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!query.trim()) return;

    if (detectedPlaylistId) {
      let autoPlayVideoId = null;
      try {
        const parsed = new URL(query.includes("://") ? query.trim() : `https://${query.trim()}`);
        const v = parsed.searchParams.get("v");
        if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) autoPlayVideoId = v;
      } catch {
        // Ignore URL parse error
      }
      handleOpenYouTubePlaylist(query, { source: "auto", autoPlayVideoId });
    } else if (isLikelyYouTubeUrl(query)) {
      handlePlayDirectUrl(query);
    } else {
      setActiveTab("explore");
      performSearch(query, { saveToHistory: true, contextLabel: "" });
    }
  };

  const handleSurpriseMe = () => {
    const next = pickRandomSearch(activeSearchQuery);
    setQuery(next);
    setActiveTab("explore");
    performSearch(next, {
      saveToHistory: false,
      contextLabel: "🎲 Random Pick"
    });
  };

  const handleShuffleSuggestions = () => {
    setSuggestedTopics((prev) =>
      pickRandomSuggestedSearches(9, [...prev, activeSearchQuery])
    );
  };

  const handleChipClick = (topic) => {
    setQuery(topic);
    setActiveTab("explore");
    performSearch(topic, { saveToHistory: true, contextLabel: "✨ Suggested" });
  };

  const handleMoodClick = (section) => {
    const nextQuery = pickQueryForSection(section.id, activeSearchQuery);
    setQuery(nextQuery);
    setActiveTab("explore");
    performSearch(nextQuery, {
      saveToHistory: false,
      contextLabel: `${section.emoji} ${section.title}`
    });
    resultsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const handleRerollShelf = (shelfId, keepQuery = false) => {
    const target = shelves.find((s) => s.id === shelfId);
    if (!target) return;
    const nextQuery = keepQuery
      ? target.activeQuery
      : pickQueryForSection(shelfId, target.activeQuery);
    setShelves((prev) =>
      prev.map((s) => (s.id === shelfId ? { ...s, activeQuery: nextQuery } : s))
    );
    fetchShelfVideos(shelfId, nextQuery);
  };

  const handleExploreAllShelf = (shelf) => {
    setQuery(shelf.activeQuery);
    setActiveTab("explore");
    performSearch(shelf.activeQuery, {
      saveToHistory: true,
      contextLabel: `${shelf.emoji} ${shelf.title}`
    });
    resultsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const remainingSections = useMemo(() => {
    const activeIds = new Set(shelves.map((s) => s.id));
    return YOUTUBE_MOOD_SECTIONS.filter((s) => !activeIds.has(s.id));
  }, [shelves]);

  const handleLoadMoreShelves = () => {
    const batch = remainingSections.slice(0, 3).map((section) => ({
      ...section,
      activeQuery: pickQueryForSection(section.id)
    }));
    if (batch.length === 0) return;
    setShelves((prev) => [...prev, ...batch]);
    for (const shelf of batch) {
      fetchShelfVideos(shelf.id, shelf.activeQuery);
    }
  };

  const handleCardClick = (item) => {
    const videoObj = {
      id: `yt_${item.id}`,
      ytId: item.id,
      title: item.title,
      duration: item.duration || 0,
      src: `yt:${item.id}`,
      poster: item.thumbnail,
      course: "YouTube",
      section: item.author || "YouTube",
      isYouTube: true,
      watchedOnYouTube: Boolean(item.watchedOnYouTube)
    };
    onSelectYouTubeVideo?.(videoObj);
  };

  const handleClearRecentSearches = () => {
    setRecentSearches([]);
    writeJSON(RECENT_SEARCHES_KEY, []);
  };

  const handleClearRecentVideos = () => {
    onClearYouTubeHistory?.("all");
  };

  const isPersonalTab = activeTab === "subscriptions" || activeTab === "liked";
  const hasPersonalFeed =
    isPersonalTab && auth?.authenticated && !feedError && feedItems.length > 0;
  const showFallbackToExplore =
    isPersonalTab && (!auth?.authenticated || feedError);
  const displayedExploreOrFeed = hasPersonalFeed ? feedItems : results;

  return (
    <div className="youtube-page">
      {/* Feed Tabs Bar */}
      <div className="youtube-tabs-bar">
        <button
          type="button"
          className={`youtube-tab-btn ${activeTab === "explore" ? "active" : ""}`}
          onClick={() => handleTabChange("explore")}
        >
          🔍 Explore & Search
        </button>
        <button
          type="button"
          className={`youtube-tab-btn ${activeTab === "subscriptions" ? "active" : ""}`}
          onClick={() => handleTabChange("subscriptions")}
        >
          📺 Subscriptions
        </button>
        <button
          type="button"
          className={`youtube-tab-btn ${activeTab === "liked" ? "active" : ""}`}
          onClick={() => handleTabChange("liked")}
        >
          👍 Liked
        </button>
        <button
          type="button"
          className={`youtube-tab-btn ${activeTab === "playlists" ? "active" : ""}`}
          onClick={() => handleTabChange("playlists")}
        >
          📋 Playlists
          {customPlaylists.length + accountPlaylists.length > 0 && (
            <span className="youtube-tab-count">
              {customPlaylists.length + accountPlaylists.length}
            </span>
          )}
        </button>
        <button
          type="button"
          className={`youtube-tab-btn ${activeTab === "saved" ? "active" : ""}`}
          onClick={() => handleTabChange("saved")}
        >
          ❤️ Saved
          {savedYouTubeItems.length > 0 && (
            <span className="youtube-tab-count">{savedYouTubeItems.length}</span>
          )}
        </button>
        <button
          type="button"
          className={`youtube-tab-btn ${activeTab === "recent" ? "active" : ""}`}
          onClick={() => handleTabChange("recent")}
        >
          🕘 Watch History
          {recentVideos.length > 0 && (
            <span className="youtube-tab-count">{recentVideos.length}</span>
          )}
        </button>
      </div>

      {/* Active Playlist Queue Bar */}
      <ActivePlaylistBar
        activePlaylist={activePlaylist}
        currentVideoId={currentVideoId}
        isShuffled={isPlaylistShuffled}
        onToggleShuffle={onTogglePlaylistShuffle}
        onPrev={onPrevPlaylistVideo}
        onNext={onNextPlaylistVideo}
        onSelectTrack={handleSelectActivePlaylistTrack}
        onClose={onClearActivePlaylist}
      />

      {/* Hero section */}
      <div className="youtube-hero">
        <div className="youtube-hero-header">
          <span className="youtube-icon-badge" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
            </svg>
          </span>
          <h2 className="youtube-hero-title">YouTube WebCodecs Streamer</h2>
        </div>
        <p className="youtube-hero-desc">
          Paste any YouTube link, search anything, or spin the randomizer for unexpected rabbit holes.
          All streams are decoded via WebCodecs onto a canvas so video never pauses while driving.
        </p>

        <form onSubmit={handleSubmit} className="youtube-input-wrap">
          <div className="youtube-input-box">
            <svg
              className="youtube-search-icon"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              className="youtube-text-input"
              placeholder="Paste YouTube video or playlist link, or search anything..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                type="button"
                className="youtube-clear-btn"
                onClick={() => setQuery("")}
                aria-label="Clear input"
              >
                ✕
              </button>
            )}
          </div>

          <div className="youtube-form-buttons">
            {detectedPlaylistId ? (
              <button
                type="submit"
                className="youtube-action-btn primary"
                disabled={openedPlaylistLoading || isLoading}
              >
                {openedPlaylistLoading ? "Loading..." : "Open Playlist"}
              </button>
            ) : isLikelyYouTubeUrl(query) ? (
              <button
                type="button"
                className="youtube-action-btn primary"
                disabled={isUrlDirectPlaying || isLoading}
                onClick={() => handlePlayDirectUrl(query)}
              >
                {isUrlDirectPlaying ? "Resolving..." : "Stream Video"}
              </button>
            ) : (
              <button
                type="submit"
                className="youtube-action-btn primary"
                disabled={isLoading || !query.trim()}
              >
                {isLoading ? "Searching..." : "Search"}
              </button>
            )}

            <button
              type="button"
              className="youtube-action-btn surprise"
              disabled={isLoading}
              onClick={handleSurpriseMe}
              title="Launch a completely random creative YouTube search"
            >
              🎲 Surprise Me
            </button>
          </div>
        </form>

        {/* Randomized Creative Suggested Searches */}
        <div className="youtube-chips-row">
          <span className="youtube-chip-label">Wild ideas:</span>
          {suggestedTopics.map((topic) => (
            <button
              key={topic}
              type="button"
              className={`youtube-chip ${activeSearchQuery.toLowerCase() === topic.toLowerCase() ? "active" : ""
                }`}
              onClick={() => handleChipClick(topic)}
            >
              {topic}
            </button>
          ))}
          <button
            type="button"
            className="youtube-chip youtube-chip-shuffle"
            onClick={handleShuffleSuggestions}
            title="Deal a fresh batch of random search ideas"
          >
            ↻ Shuffle ideas
          </button>
        </div>

        {/* Recent Searches */}
        {recentSearches.length > 0 && (
          <div className="youtube-recent-searches-row">
            <span className="youtube-chip-label">Recent:</span>
            {recentSearches.map((term) => (
              <button
                key={term}
                type="button"
                className="youtube-recent-pill"
                onClick={() => handleChipClick(term)}
              >
                ↺ {term}
              </button>
            ))}
            <button
              type="button"
              className="youtube-recent-clear-btn"
              onClick={handleClearRecentSearches}
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {/* PLAYLISTS TAB */}
      {activeTab === "playlists" && (
        <YouTubePlaylistsSection
          auth={auth}
          customPlaylists={customPlaylists}
          accountPlaylists={accountPlaylists}
          accountPlaylistsLoading={accountPlaylistsLoading}
          accountPlaylistsError={accountPlaylistsError}
          onRefreshAccountPlaylists={loadAccountPlaylists}
          openedPlaylist={openedPlaylist}
          openedPlaylistLoading={openedPlaylistLoading}
          openedPlaylistError={openedPlaylistError}
          onOpenYouTubePlaylist={handleOpenYouTubePlaylist}
          onOpenCustomPlaylist={handleOpenCustomPlaylist}
          onCloseOpenedPlaylist={handleCloseOpenedPlaylist}
          onCreatePlaylist={handleCreatePlaylist}
          onRenamePlaylist={handleRenamePlaylist}
          onDeletePlaylist={handleDeletePlaylist}
          onSaveRemotePlaylist={handleSaveRemotePlaylist}
          onRemoveVideoFromPlaylist={handleRemoveVideoFromPlaylist}
          onMoveVideoInPlaylist={handleMoveVideoInPlaylist}
          onPlayPlaylist={handlePlayPlaylist}
          currentVideoId={currentVideoId}
          favorites={favorites}
          onToggleFavorite={handleToggleFavoriteItem}
        />
      )}

      {/* SAVED TAB */}
      {activeTab === "saved" && (
        <section className="youtube-section-block">
          <div className="youtube-section-header">
            <div>
              <h3 className="youtube-section-title">❤️ Saved YouTube Videos</h3>
              <p className="youtube-section-subtitle">
                Videos you&apos;ve hearted on YouTube appear here for quick streaming.
              </p>
            </div>
          </div>

          {savedYouTubeItems.length === 0 ? (
            <div className="youtube-status-msg">
              <p>No saved YouTube videos yet. Tap the heart on any video card to save it here.</p>
              <button
                type="button"
                className="youtube-action-btn primary"
                style={{ marginTop: "0.75rem" }}
                onClick={() => setActiveTab("explore")}
              >
                Explore Videos
              </button>
            </div>
          ) : (
            <div className="youtube-grid">
              {savedYouTubeItems.map((item) => {
                const videoId = `yt_${item.id}`;
                return (
                  <VideoCard
                    key={item.id}
                    item={item}
                    isPlaying={currentVideoId === videoId}
                    isFav={Boolean(favorites[videoId])}
                    onSelect={handleCardClick}
                    onToggleFavorite={handleToggleFavoriteItem}
                    onAddToPlaylist={setPlaylistPickerVideo}
                  />
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* WATCH HISTORY TAB */}
      {activeTab === "recent" && (
        <section className="youtube-section-block">
          <div className="youtube-section-header">
            <div>
              <h3 className="youtube-section-title">🕘 YouTube Watch History</h3>
              <p className="youtube-section-subtitle">
                Videos you&apos;ve watched on YouTube and TylerTube, synced in one place.
                {youtubeHistorySync?.lastSyncedAt > 0 && (
                  <> · Last synced {formatRelativeWatchTime(youtubeHistorySync.lastSyncedAt)}</>
                )}
              </p>
            </div>
            <div className="youtube-history-header-actions">
              {youtubeHistorySync?.liveConfigured && (
                <button
                  type="button"
                  className="youtube-action-btn primary youtube-btn-sm"
                  disabled={historyBusy}
                  onClick={() => handleRunLiveSync("")}
                >
                  {historyBusy ? "Syncing..." : "↻ Sync from YouTube"}
                </button>
              )}
              <button
                type="button"
                className="youtube-shelf-btn"
                onClick={() => setHistorySyncOpen((prev) => !prev)}
              >
                {historySyncOpen ? "Hide Sync Options" : "⚙ Connect / Import"}
              </button>
              {recentVideos.length > 0 && (
                <button
                  type="button"
                  className="youtube-shelf-btn"
                  onClick={handleClearRecentVideos}
                >
                  Clear History
                </button>
              )}
            </div>
          </div>

          {historyStatus && (
            <div
              className={`youtube-history-status ${historyStatus.type === "error" ? "is-error" : "is-success"
                }`}
              role="status"
            >
              <span>{historyStatus.text}</span>
              <button
                type="button"
                className="youtube-notice-close-btn"
                onClick={() => setHistoryStatus(null)}
                aria-label="Dismiss message"
              >
                ✕
              </button>
            </div>
          )}

          {/* Sync / Import Setup Panel */}
          {(historySyncOpen || youtubeOnlyCount === 0) && (
            <div className="youtube-history-sync-panel">
              <div className="youtube-history-sync-note">
                <strong>Bring in your YouTube.com watch history:</strong> Google disabled Watch
                History access in the YouTube Data API, so TylerTube supports live sync via{" "}
                <code>yt-dlp</code> cookies or a one-click Google Takeout import.
              </div>

              <div className="youtube-history-sync-grid">
                {/* Option 1: Live Sync via yt-dlp cookies */}
                <div className="youtube-history-sync-card">
                  <div className="youtube-history-sync-card-head">
                    <h4>⚡ Live Sync (YouTube Cookies)</h4>
                    <span
                      className={`youtube-sync-pill ${youtubeHistorySync?.liveConfigured ? "connected" : ""
                        }`}
                    >
                      {youtubeHistorySync?.liveConfigured
                        ? `Connected (${youtubeHistorySync.cookieSource === "browser" ? youtubeHistorySync.browser : "cookies.txt"})`
                        : "Not connected"}
                    </span>
                  </div>
                  <p className="youtube-history-sync-desc">
                    Pull your latest YouTube watch history live on demand using browser cookies on
                    the host machine or an uploaded <code>cookies.txt</code>.
                  </p>

                  <div className="youtube-history-sync-row">
                    <select
                      className="youtube-browser-select"
                      value={selectedBrowser}
                      onChange={(e) => setSelectedBrowser(e.target.value)}
                      aria-label="Browser to read YouTube cookies from"
                    >
                      {SUPPORTED_BROWSERS.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.label} (local host)
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="youtube-action-btn primary youtube-btn-sm"
                      disabled={historyBusy}
                      onClick={() => handleRunLiveSync(selectedBrowser)}
                    >
                      {historyBusy ? "Syncing..." : "Sync from Browser"}
                    </button>
                  </div>

                  <div className="youtube-history-sync-divider">
                    <span>or upload Netscape cookies.txt</span>
                  </div>

                  <div className="youtube-history-sync-row">
                    <input
                      ref={cookiesInputRef}
                      type="file"
                      accept=".txt,text/plain"
                      style={{ display: "none" }}
                      onChange={handleCookiesFileChange}
                    />
                    <button
                      type="button"
                      className="youtube-shelf-btn"
                      disabled={historyBusy}
                      onClick={() => cookiesInputRef.current?.click()}
                    >
                      📄 Upload cookies.txt
                    </button>
                    {youtubeHistorySync?.cookieSource === "uploaded" && (
                      <button
                        type="button"
                        className="youtube-shelf-btn"
                        disabled={historyBusy}
                        onClick={handleDisconnectCookies}
                      >
                        Remove Saved Cookies
                      </button>
                    )}
                  </div>

                  <details className="youtube-cookies-paste-details">
                    <summary>Paste cookies.txt text instead</summary>
                    <textarea
                      className="youtube-cookies-textarea"
                      rows={3}
                      placeholder="# Netscape HTTP Cookie File..."
                      value={cookiesText}
                      onChange={(e) => setCookiesText(e.target.value)}
                    />
                    <button
                      type="button"
                      className="youtube-shelf-btn"
                      disabled={historyBusy || !cookiesText.trim()}
                      onClick={() => handleSaveCookiesAndSync(cookiesText)}
                    >
                      Save &amp; Sync Cookies
                    </button>
                  </details>
                </div>

                {/* Option 2: Google Takeout Import */}
                <div className="youtube-history-sync-card">
                  <div className="youtube-history-sync-card-head">
                    <h4>📦 Import Google Takeout</h4>
                    {youtubeHistorySync?.lastImportedAt > 0 && (
                      <span className="youtube-sync-pill connected">
                        Imported {formatRelativeWatchTime(youtubeHistorySync.lastImportedAt)}
                      </span>
                    )}
                  </div>
                  <p className="youtube-history-sync-desc">
                    Export your official YouTube history from{" "}
                    <a
                      href="https://takeout.google.com/"
                      target="_blank"
                      rel="noreferrer"
                      className="youtube-inline-link"
                    >
                      takeout.google.com
                    </a>{" "}
                    (YouTube and YouTube Music → history → <code>watch-history.json</code> or{" "}
                    <code>watch-history.html</code>). Parsed locally in your browser so even huge
                    exports import instantly.
                  </p>
                  <div className="youtube-history-sync-row">
                    <input
                      ref={takeoutInputRef}
                      type="file"
                      accept=".json,.html,.htm,application/json,text/html"
                      style={{ display: "none" }}
                      onChange={handleTakeoutFileChange}
                    />
                    <button
                      type="button"
                      className="youtube-action-btn primary youtube-btn-sm"
                      disabled={historyBusy}
                      onClick={() => takeoutInputRef.current?.click()}
                    >
                      {historyBusy ? "Importing..." : "⬆ Choose watch-history.json / .html"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Source Filter Pills */}
          {recentVideos.length > 0 && (
            <div className="youtube-history-filter-row">
              <button
                type="button"
                className={`youtube-chip ${historySourceFilter === "all" ? "active" : ""}`}
                onClick={() => setHistorySourceFilter("all")}
              >
                All ({recentVideos.length})
              </button>
              <button
                type="button"
                className={`youtube-chip ${historySourceFilter === "youtube" ? "active" : ""}`}
                onClick={() => setHistorySourceFilter("youtube")}
              >
                On YouTube ({youtubeOnlyCount})
              </button>
              <button
                type="button"
                className={`youtube-chip ${historySourceFilter === "tylertube" ? "active" : ""}`}
                onClick={() => setHistorySourceFilter("tylertube")}
              >
                On TylerTube ({tylertubeOnlyCount})
              </button>
            </div>
          )}

          {filteredRecentVideos.length === 0 ? (
            <div className="youtube-status-msg">
              <p>
                {recentVideos.length === 0
                  ? "No YouTube watch history yet. Sync your YouTube history above or stream a video from Explore!"
                  : "No videos match this filter."}
              </p>
              <button
                type="button"
                className="youtube-action-btn primary"
                style={{ marginTop: "0.75rem" }}
                onClick={() =>
                  recentVideos.length === 0
                    ? setActiveTab("explore")
                    : setHistorySourceFilter("all")
                }
              >
                {recentVideos.length === 0 ? "Explore Videos" : "Show All History"}
              </button>
            </div>
          ) : (
            <div className="youtube-grid">
              {filteredRecentVideos.map((item) => {
                const videoId = `yt_${item.id}`;
                return (
                  <VideoCard
                    key={item.id}
                    item={item}
                    showSourceBadge
                    isPlaying={currentVideoId === videoId}
                    isFav={Boolean(favorites[videoId])}
                    onSelect={handleCardClick}
                    onToggleFavorite={handleToggleFavoriteItem}
                    onAddToPlaylist={setPlaylistPickerVideo}
                    onRemove={onRemoveYouTubeHistoryItem}
                  />
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* EXPLORE, SUBSCRIPTIONS, LIKED TABS */}
      {(activeTab === "explore" || isPersonalTab) && (
        <>
          {/* Fallback & Prompt Card when personal tab is selected but unauthenticated or failing */}
          {showFallbackToExplore && (
            <div className="youtube-auth-prompt-card">
              <div className="youtube-auth-prompt-header">
                <span>ℹ️</span>
                <span>
                  {feedError
                    ? "Unable to load personal feed"
                    : activeTab === "subscriptions"
                      ? "Sign in to view your Subscriptions feed"
                      : "Sign in to view your Liked Videos"}
                </span>
              </div>
              <p className="youtube-auth-prompt-desc">
                {feedError
                  ? `${feedError} We've defaulted to your explore view below so you can keep watching.`
                  : auth?.configured === false
                    ? "Google OAuth credentials are not configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env to connect your YouTube account. Showing public explore view below:"
                    : "Sign in with your Google account to stream uploads from your favorite creators. Showing explore videos below in the meantime:"}
              </p>
              <div className="youtube-auth-actions-row">
                {auth?.configured !== false && !auth?.authenticated && (
                  <a
                    href={getGoogleLoginUrl("youtube")}
                    className="youtube-google-login-btn"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                    </svg>
                    Sign in with Google
                  </a>
                )}
                <button
                  type="button"
                  className="youtube-action-btn"
                  onClick={() => setActiveTab("explore")}
                >
                  Back to Explore
                </button>
              </div>
            </div>
          )}

          {/* Section: Explore by Mood / Rabbit Holes (shown on Explore tab) */}
          {activeTab === "explore" && (
            <section className="youtube-section-block youtube-moods-section">
              <div className="youtube-section-header">
                <div>
                  <h3 className="youtube-section-title">🧭 Dive Into a Vibe</h3>
                  <p className="youtube-section-subtitle">
                    Pick any mood to roll a random search from that corner of YouTube.
                  </p>
                </div>
              </div>

              <div className="youtube-mood-grid">
                {YOUTUBE_MOOD_SECTIONS.map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    className="youtube-mood-card"
                    style={{ "--mood-accent": section.accent }}
                    onClick={() => handleMoodClick(section)}
                  >
                    <span className="youtube-mood-emoji" aria-hidden="true">
                      {section.emoji}
                    </span>
                    <div className="youtube-mood-text">
                      <div className="youtube-mood-title">{section.title}</div>
                      <div className="youtube-mood-sub">{section.subtitle}</div>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Section: Active Search Results / Personal Feed */}
          <section className="youtube-section-block" ref={resultsSectionRef}>
            {!hasPersonalFeed && (
              <div className="youtube-section-header">
                <div className="youtube-results-heading">
                  <div className="youtube-results-title-row">
                    <h3 className="youtube-section-title">
                      Now Exploring: <span className="youtube-query-highlight">“{activeSearchQuery}”</span>
                    </h3>
                    {searchContextLabel && (
                      <span className="youtube-context-badge">{searchContextLabel}</span>
                    )}
                  </div>
                  {!isLoading && displayedExploreOrFeed.length > 0 && (
                    <p className="youtube-section-subtitle">
                      Showing {displayedExploreOrFeed.length} streamable results
                    </p>
                  )}
                </div>

                <button
                  type="button"
                  className="youtube-shelf-btn"
                  onClick={handleSurpriseMe}
                  disabled={isLoading}
                >
                  🎲 Roll Another
                </button>
              </div>
            )}

            {/* Loading states */}
            {(isLoading || feedLoading) && (
              <div className="youtube-status-msg">
                <div className="youtube-spinner" />
                <p>
                  {feedLoading
                    ? "Fetching your YouTube feed & metadata..."
                    : `Searching YouTube for “${activeSearchQuery}”...`}
                </p>
              </div>
            )}

            {/* Error state for explore */}
            {error && !isLoading && !isPersonalTab && (
              <div className="youtube-status-msg">
                <p style={{ color: "#ff4d4f", marginBottom: "0.75rem" }}>{error}</p>
                <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="youtube-action-btn primary"
                    onClick={() => performSearch(activeSearchQuery || pickRandomSearch())}
                  >
                    Retry Search
                  </button>
                  <button
                    type="button"
                    className="youtube-action-btn surprise"
                    onClick={handleSurpriseMe}
                  >
                    🎲 Try Random Instead
                  </button>
                </div>
              </div>
            )}

            {/* Empty state */}
            {!isLoading && !feedLoading && displayedExploreOrFeed.length === 0 && !error && (
              <div className="youtube-status-msg">
                <p>No YouTube videos found. Try rolling a new random search or pasting a direct link.</p>
                <button
                  type="button"
                  className="youtube-action-btn surprise"
                  style={{ marginTop: "0.75rem" }}
                  onClick={handleSurpriseMe}
                >
                  🎲 Roll Random Search
                </button>
              </div>
            )}

            {/* Grid of videos */}
            {!isLoading && !feedLoading && displayedExploreOrFeed.length > 0 && (
              <div className="youtube-grid">
                {displayedExploreOrFeed.map((item) => {
                  const videoId = `yt_${item.id}`;
                  return (
                    <VideoCard
                      key={item.id}
                      item={item}
                      isPlaying={currentVideoId === videoId}
                      isFav={Boolean(favorites[videoId])}
                      onSelect={handleCardClick}
                      onToggleFavorite={handleToggleFavoriteItem}
                    />
                  );
                })}
              </div>
            )}
          </section>

          {/* Section: Recently Watched Shelf (on Explore tab when user has watched YouTube videos) */}
          {activeTab === "explore" && recentVideos.length > 0 && (
            <section className="youtube-shelf" style={{ "--shelf-accent": "var(--accent)" }}>
              <div className="youtube-shelf-header">
                <div className="youtube-shelf-heading">
                  <span className="youtube-shelf-emoji" aria-hidden="true">
                    🕘
                  </span>
                  <div>
                    <div className="youtube-shelf-title-row">
                      <h3 className="youtube-shelf-title">Jump Back In</h3>
                    </div>
                    <p className="youtube-shelf-subtitle">
                      Recent videos from your YouTube &amp; TylerTube watch history
                    </p>
                  </div>
                </div>
                <div className="youtube-shelf-actions">
                  <button
                    type="button"
                    className="youtube-shelf-btn"
                    onClick={() => setActiveTab("recent")}
                  >
                    View all ({recentVideos.length})
                  </button>
                  <button
                    type="button"
                    className="youtube-shelf-btn"
                    onClick={handleClearRecentVideos}
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div className="youtube-shelf-track">
                {recentVideos.slice(0, 10).map((item) => {
                  const videoId = `yt_${item.id}`;
                  return (
                    <VideoCard
                      key={item.id}
                      item={item}
                      compact
                      isPlaying={currentVideoId === videoId}
                      isFav={Boolean(favorites[videoId])}
                      onSelect={handleCardClick}
                      onToggleFavorite={handleToggleFavoriteItem}
                    />
                  );
                })}
              </div>
            </section>
          )}

          {/* Sections: Live Themed Discovery Shelves (on Explore tab) */}
          {activeTab === "explore" && (
            <div className="youtube-shelves-container">
              {shelves.map((shelf) => (
                <DiscoveryShelf
                  key={shelf.id}
                  shelf={shelf}
                  state={shelfData[shelf.id]}
                  currentVideoId={currentVideoId}
                  favorites={favorites}
                  onSelect={handleCardClick}
                  onToggleFavorite={handleToggleFavoriteItem}
                  onAddToPlaylist={setPlaylistPickerVideo}
                  onReroll={handleRerollShelf}
                  onExploreAll={handleExploreAllShelf}
                />
              ))}

              {remainingSections.length > 0 && (
                <div className="youtube-load-more-wrap">
                  <button
                    type="button"
                    className="youtube-load-more-btn"
                    onClick={handleLoadMoreShelves}
                  >
                    ✨ Load More Discovery Sections ({remainingSections.length} more)
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <AddToPlaylistModal
        video={playlistPickerVideo}
        customPlaylists={customPlaylists}
        onToggleVideoInPlaylist={handleToggleVideoInPlaylist}
        onCreateAndAdd={handleCreateAndAddVideo}
        onClose={() => setPlaylistPickerVideo(null)}
      />
    </div>
  );
}
