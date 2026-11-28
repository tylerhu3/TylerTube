import React, { useState, useEffect, useCallback, useRef, memo } from "react";
import { formatDuration, formatViewCount } from "../utils/format";
import { readString, writeString } from "../lib/storage";
import { getGoogleLoginUrl } from "../lib/auth";

const LAST_SHORTS_QUERY_KEY = "tylertube_shorts_last_query";

const PRESET_TOPICS = [
  "Trending Shorts",
  "Viral Comedy",
  "Tesla & Cars",
  "Tech & Hacks",
  "Satisfying Loops",
  "Daily Motivation"
];

function isLikelyShortsUrl(str) {
  const s = String(str || "").trim().toLowerCase();
  return (
    s.includes("youtube.com/shorts/") ||
    s.includes("youtu.be") ||
    s.startsWith("yt:") ||
    /^[a-zA-Z0-9_-]{11}$/.test(s)
  );
}

function toShortVideoObject(item) {
  return {
    id: `yt_${item.id}`,
    ytId: item.id,
    title: item.title,
    duration: item.duration || 0,
    src: `yt:${item.id}`,
    poster: item.thumbnail,
    course: "YouTube Shorts",
    section: item.author || "YouTube",
    isYouTube: true,
    isShort: true
  };
}

const ShortsCard = memo(function ShortsCard({
  item,
  isPlaying,
  isFav,
  onSelect,
  onToggleFavorite
}) {
  const videoId = `yt_${item.id}`;
  const viewsLabel = formatViewCount(item.viewCount);

  return (
    <div
      className={`shorts-card ${isPlaying ? "active-playing" : ""}`}
      onClick={() => onSelect(item)}
    >
      <div className="shorts-card-thumb-wrap">
        <img
          src={item.thumbnail}
          alt={item.title}
          className="shorts-card-thumb"
          loading="lazy"
          decoding="async"
        />
        <span className="shorts-card-badge">⚡ SHORT</span>
        {item.duration > 0 && (
          <span className="shorts-card-duration">
            {formatDuration(item.duration)}
          </span>
        )}
        {isPlaying && (
          <div className="youtube-card-playing-badge">
            <span>▶ PLAYING</span>
          </div>
        )}
      </div>

      <div className="shorts-card-content">
        <h3 className="shorts-card-title" title={item.title}>
          {item.title}
        </h3>
        <div className="shorts-card-author">
          <span>{item.author}</span>
          {viewsLabel && (
            <>
              <span aria-hidden="true"> · </span>
              <span>{viewsLabel}</span>
            </>
          )}
        </div>

        <div className="shorts-card-footer">
          <span className="youtube-card-badge">
            {item.feedSource === "subscription-short"
              ? "Subscribed"
              : item.feedSource === "liked"
                ? "Liked"
                : item.feedSource === "tailored-creator"
                  ? "For You"
                  : "WebCodecs"}
          </span>
          <button
            type="button"
            className={`youtube-fav-btn ${isFav ? "favorited" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite?.(videoId);
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
  );
});

const ShortsPage = memo(function ShortsPage({
  onSelectShort,
  currentVideoId,
  favorites = {},
  onToggleFavorite,
  auth = null,
  youtubeHistory = []
}) {
  const [activeTab, setActiveTab] = useState("forYou"); // "forYou" | "subscriptions" | "explore"
  const [query, setQuery] = useState(() => readString(LAST_SHORTS_QUERY_KEY, ""));
  const [results, setResults] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isUrlDirectPlaying, setIsUrlDirectPlaying] = useState(false);

  // Tailored "For You" feed state (combines Google OAuth subscriptions/likes + YouTube watch history)
  const [tailoredItems, setTailoredItems] = useState([]);
  const [tailoredMeta, setTailoredMeta] = useState({
    tailored: false,
    sources: [],
    seedCreators: []
  });
  const [tailoredLoading, setTailoredLoading] = useState(false);
  const [tailoredError, setTailoredError] = useState(null);

  // Direct Subscriptions Shorts feed state
  const [feedItems, setFeedItems] = useState([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedError, setFeedError] = useState(null);

  const prefetchedKeyRef = useRef("");

  const performSearch = useCallback(async (searchQuery) => {
    const q = String(searchQuery || "").trim();
    if (!q) return;

    setIsLoading(true);
    setError(null);
    writeString(LAST_SHORTS_QUERY_KEY, q);

    try {
      const res = await fetch(`/api/youtube/shorts?q=${encodeURIComponent(q)}&limit=24`);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Search failed with status ${res.status}`);
      }
      const data = await res.json();
      setResults(data.items || []);
    } catch (err) {
      setError(err.message || "Failed to search YouTube Shorts");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadTailoredShorts = useCallback(async () => {
    setTailoredLoading(true);
    setTailoredError(null);

    try {
      const res = await fetch("/api/youtube/shorts/tailored?limit=24");
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Failed to load tailored shorts (${res.status})`);
      }
      const data = await res.json();
      setTailoredItems(data.items || []);
      setTailoredMeta({
        tailored: Boolean(data.tailored),
        sources: Array.isArray(data.sources) ? data.sources : [],
        seedCreators: Array.isArray(data.seedCreators) ? data.seedCreators : []
      });
    } catch (err) {
      setTailoredError(err.message || "Could not load tailored shorts.");
    } finally {
      setTailoredLoading(false);
    }
  }, []);

  // Fetch personalized subscriptions shorts feed
  const loadPersonalShortsFeed = useCallback(async () => {
    if (!auth?.authenticated) return;
    setFeedLoading(true);
    setFeedError(null);

    try {
      const res = await fetch("/api/youtube/feed/shorts");
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Failed to fetch personalized shorts (${res.status})`);
      }
      const data = await res.json();
      setFeedItems(data.items || []);
    } catch (err) {
      setFeedError(err.message || "Could not load personalized shorts. Showing trending shorts below.");
    } finally {
      setFeedLoading(false);
    }
  }, [auth?.authenticated]);

  // Initial load: fetch tailored Shorts AND fallback trending/explore Shorts
  useEffect(() => {
    loadTailoredShorts();
    const initial = query || "Trending Shorts";
    performSearch(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch tailored Shorts whenever Google auth state or YouTube history count changes
  const historyLen = youtubeHistory.length;
  useEffect(() => {
    if (auth?.authenticated || historyLen > 0) {
      loadTailoredShorts();
    }
  }, [auth?.authenticated, auth?.user?.id, historyLen, loadTailoredShorts]);

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    setFeedError(null);
    if (tab === "forYou") {
      if (tailoredItems.length === 0) loadTailoredShorts();
    } else if (tab === "subscriptions") {
      if (auth?.authenticated) {
        loadPersonalShortsFeed();
      }
    }
  };

  const isForYouTab = activeTab === "forYou";
  const isSubsTab = activeTab === "subscriptions";
  const hasTailoredFeed = isForYouTab && !tailoredError && tailoredItems.length > 0;
  const hasSubsFeed = isSubsTab && auth?.authenticated && !feedError && feedItems.length > 0;

  const displayedItems = hasTailoredFeed
    ? tailoredItems
    : hasSubsFeed
      ? feedItems
      : results;

  const isBusy =
    (isForYouTab && tailoredLoading && tailoredItems.length === 0) ||
    (isSubsTab && feedLoading && feedItems.length === 0) ||
    (!hasTailoredFeed && !hasSubsFeed && isLoading && results.length === 0);

  // Warm the first 2 Shorts in the current view so the very first click starts fast
  useEffect(() => {
    if (!displayedItems || displayedItems.length === 0) return;
    const topIds = displayedItems.slice(0, 2).map((item) => item.id).filter(Boolean);
    const key = topIds.join(",");
    if (!key || prefetchedKeyRef.current === key) return;
    prefetchedKeyRef.current = key;
    fetch(`/api/youtube/prefetch?ids=${encodeURIComponent(key)}&quality=480`).catch(() => {});
  }, [displayedItems]);

  const buildShortsQueue = useCallback(
    (items) => ({
      id: `shorts_${activeTab}`,
      title:
        activeTab === "forYou"
          ? "For You Shorts"
          : activeTab === "subscriptions"
            ? "Subscriptions Shorts"
            : query || "Explore Shorts",
      isShortsFeed: true,
      items: items.map((it) => ({ ...it, isShort: true }))
    }),
    [activeTab, query]
  );

  const handlePlayDirectUrl = async (urlOrId) => {
    const raw = String(urlOrId || query).trim();
    if (!raw) return;

    setIsUrlDirectPlaying(true);
    setError(null);

    try {
      const res = await fetch(`/api/youtube/info?v=${encodeURIComponent(raw)}`);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || "Failed to resolve YouTube Short");
      }
      const info = await res.json();
      const videoObj = toShortVideoObject(info);
      const queue = displayedItems.length > 0 ? buildShortsQueue([info, ...displayedItems]) : null;
      onSelectShort?.(videoObj, queue);
    } catch (err) {
      setError(err.message || "Could not play YouTube Short URL");
    } finally {
      setIsUrlDirectPlaying(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!query.trim()) return;

    if (isLikelyShortsUrl(query)) {
      handlePlayDirectUrl(query);
    } else {
      setActiveTab("explore");
      performSearch(query);
    }
  };

  const handleChipClick = (topic) => {
    setQuery(topic);
    setActiveTab("explore");
    performSearch(topic);
  };

  const handleCardClick = useCallback(
    (item) => {
      const videoObj = toShortVideoObject(item);
      const queue = buildShortsQueue(displayedItems);
      onSelectShort?.(videoObj, queue);
    },
    [displayedItems, buildShortsQueue, onSelectShort]
  );

  const handleWatchFeed = () => {
    if (displayedItems.length === 0) return;
    handleCardClick(displayedItems[0]);
  };

  const showSubsFallback = isSubsTab && (!auth?.authenticated || feedError);
  const showForYouSignInHint =
    isForYouTab && !tailoredLoading && !hasTailoredFeed && !auth?.authenticated;

  const sourceLabel = (() => {
    const s = tailoredMeta.sources;
    if (s.includes("subscriptions") && s.includes("history")) {
      return "Tailored to your YouTube subscriptions, likes & watch history";
    }
    if (s.includes("subscriptions")) {
      return "Tailored to your YouTube subscriptions & likes";
    }
    if (s.includes("history")) {
      return "Tailored to your YouTube watch history";
    }
    return "Tailored to your YouTube";
  })();

  return (
    <div className="shorts-page">
      {/* Tabs Bar */}
      <div className="youtube-tabs-bar">
        <button
          type="button"
          className={`youtube-tab-btn ${activeTab === "forYou" ? "active" : ""}`}
          onClick={() => handleTabChange("forYou")}
        >
          ✨ For You
        </button>
        <button
          type="button"
          className={`youtube-tab-btn ${activeTab === "subscriptions" ? "active" : ""}`}
          onClick={() => handleTabChange("subscriptions")}
        >
          📱 My Subscriptions
        </button>
        <button
          type="button"
          className={`youtube-tab-btn ${activeTab === "explore" ? "active" : ""}`}
          onClick={() => handleTabChange("explore")}
        >
          🔥 Explore Shorts
        </button>

        {displayedItems.length > 0 && (
          <button
            type="button"
            className="shorts-watch-feed-btn"
            onClick={handleWatchFeed}
            title="Start vertical Shorts player (Scroll / Swipe / ↑↓ to switch)"
          >
            ▶ Watch Shorts Feed
          </button>
        )}
      </div>

      <div className="shorts-hero">
        <div className="youtube-hero-header">
          <span className="shorts-icon-badge" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <rect x="5" y="2" width="14" height="20" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
              <polygon points="10 8 16 12 10 16 10 8" />
            </svg>
          </span>
          <h2 className="youtube-hero-title">YouTube Shorts Portal</h2>
        </div>
        <p className="youtube-hero-desc">
          Tailored to your YouTube subscriptions &amp; watch history. Click any Short and scroll,
          swipe up/down, or press ↑↓ to jump to the next Short.
        </p>

        <form onSubmit={handleSubmit} className="youtube-input-wrap">
          <div className="youtube-input-box">
            <svg className="youtube-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              className="youtube-text-input"
              placeholder="Paste Shorts link (e.g. youtube.com/shorts/...) or search terms..."
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

          {isLikelyShortsUrl(query) ? (
            <button
              type="button"
              className="youtube-action-btn primary"
              disabled={isUrlDirectPlaying || isLoading}
              onClick={() => handlePlayDirectUrl(query)}
            >
              {isUrlDirectPlaying ? "Resolving..." : "Stream Short"}
            </button>
          ) : (
            <button
              type="submit"
              className="youtube-action-btn primary"
              disabled={isLoading || !query.trim()}
            >
              {isLoading ? "Searching..." : "Search Shorts"}
            </button>
          )}
        </form>

        <div className="youtube-chips-row">
          <span className="youtube-chip-label">Quick Topics:</span>
          {PRESET_TOPICS.map((topic) => (
            <button
              key={topic}
              type="button"
              className="youtube-chip"
              onClick={() => handleChipClick(topic)}
            >
              {topic}
            </button>
          ))}
        </div>
      </div>

      {/* Tailoring status bar for "For You" tab */}
      {isForYouTab && hasTailoredFeed && (
        <div className="shorts-tailored-bar">
          <div className="shorts-tailored-info">
            <span className="shorts-tailored-badge">✨ {sourceLabel}</span>
            {tailoredMeta.seedCreators.length > 0 && (
              <span className="shorts-tailored-creators">
                Creators: {tailoredMeta.seedCreators.slice(0, 4).join(", ")}
              </span>
            )}
          </div>
          <button
            type="button"
            className="youtube-shelf-btn"
            onClick={loadTailoredShorts}
            disabled={tailoredLoading}
          >
            {tailoredLoading ? "Refreshing..." : "↻ Refresh"}
          </button>
        </div>
      )}

      {/* Helpful sign-in prompt when For You has no user signals yet */}
      {showForYouSignInHint && (
        <div className="youtube-auth-prompt-card">
          <div className="youtube-auth-prompt-header">
            <span>✨</span>
            <span>Personalize your Shorts feed</span>
          </div>
          <p className="youtube-auth-prompt-desc">
            {auth?.configured === false
              ? "Watch videos on TylerTube or sync your YouTube watch history to tailor Shorts to your taste. Showing trending shorts below:"
              : "Sign in with Google or sync your YouTube watch history to see Shorts from creators you subscribe to and watch. Showing trending shorts below:"}
          </p>
          {auth?.configured !== false && (
            <div className="youtube-auth-actions-row">
              <a href={getGoogleLoginUrl("shorts")} className="youtube-google-login-btn">
                <svg width="18" height="18" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                </svg>
                Sign in with Google
              </a>
            </div>
          )}
        </div>
      )}

      {/* Fallback card for subscriptions shorts tab */}
      {showSubsFallback && (
        <div className="youtube-auth-prompt-card">
          <div className="youtube-auth-prompt-header">
            <span>ℹ️</span>
            <span>
              {feedError
                ? "Unable to load personalized Shorts"
                : "Sign in to view Shorts from your subscriptions"}
            </span>
          </div>
          <p className="youtube-auth-prompt-desc">
            {feedError
              ? `${feedError} Defaulting to trending shorts below.`
              : auth?.configured === false
                ? "Google OAuth credentials are not configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env to enable. Showing trending shorts below:"
                : "Sign in with your Google account to stream short clips from creators you follow. Showing trending shorts below in the meantime:"}
          </p>
          <div className="youtube-auth-actions-row">
            {auth?.configured !== false && !auth?.authenticated && (
              <a
                href={getGoogleLoginUrl("shorts")}
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

      {isBusy && (
        <div className="youtube-status-msg">
          <div className="youtube-spinner" />
          <p>
            {isForYouTab
              ? "Tailoring YouTube Shorts for you..."
              : isSubsTab
                ? "Fetching Shorts from your subscriptions..."
                : "Fetching YouTube Shorts & stream metadata..."}
          </p>
        </div>
      )}

      {error && !isBusy && activeTab === "explore" && (
        <div className="youtube-status-msg">
          <p style={{ color: "#ff4d4f", marginBottom: "0.75rem" }}>{error}</p>
          <button
            type="button"
            className="youtube-action-btn primary"
            onClick={() => performSearch(query || "Trending Shorts")}
          >
            Retry Search
          </button>
        </div>
      )}

      {!isBusy && displayedItems.length === 0 && !error && (
        <div className="youtube-status-msg">
          <p>No YouTube Shorts found. Try a different query or paste a direct video link.</p>
        </div>
      )}

      {!isBusy && displayedItems.length > 0 && (
        <div className="shorts-grid">
          {displayedItems.map((item) => {
            const videoId = `yt_${item.id}`;
            return (
              <ShortsCard
                key={item.id}
                item={item}
                isPlaying={currentVideoId === videoId}
                isFav={Boolean(favorites[videoId])}
                onSelect={handleCardClick}
                onToggleFavorite={onToggleFavorite}
              />
            );
          })}
        </div>
      )}
    </div>
  );
});

export default ShortsPage;
