import React, { useState, useEffect, useCallback } from "react";
import { formatDuration } from "../utils/format";
import { readString, writeString } from "../lib/storage";
import { getGoogleLoginUrl } from "../lib/auth";

const LAST_QUERY_KEY = "tylertube_youtube_last_query";

const PRESET_TOPICS = [
  "Lofi Hip Hop",
  "Synthwave Chill",
  "Tesla Autopilot Drive",
  "Night Drive 4K",
  "Ambient Relaxation",
  "Tech News"
];

function isLikelyYouTubeUrl(str) {
  const s = String(str || "").trim().toLowerCase();
  return (
    s.includes("youtube.com") ||
    s.includes("youtu.be") ||
    s.startsWith("yt:") ||
    /^[a-zA-Z0-9_-]{11}$/.test(s)
  );
}

export default function YouTubePage({
  onSelectYouTubeVideo,
  currentVideoId,
  favorites = {},
  onToggleFavorite,
  auth = null
}) {
  const [activeTab, setActiveTab] = useState("explore"); // "explore" | "subscriptions" | "liked"
  const [query, setQuery] = useState(() => readString(LAST_QUERY_KEY, ""));
  const [results, setResults] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isUrlDirectPlaying, setIsUrlDirectPlaying] = useState(false);

  // Personalized feed state
  const [feedItems, setFeedItems] = useState([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedError, setFeedError] = useState(null);

  const performSearch = useCallback(async (searchQuery) => {
    const q = String(searchQuery || "").trim();
    if (!q) return;

    setIsLoading(true);
    setError(null);
    writeString(LAST_QUERY_KEY, q);

    try {
      const res = await fetch(`/api/youtube/search?q=${encodeURIComponent(q)}&limit=24`);
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
  }, []);

  // Pre-load initial explore search
  useEffect(() => {
    const initial = query || "Lofi Hip Hop";
    performSearch(initial);
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
        throw new Error(errJson.error || `Failed to fetch subscriptions (${res.status})`);
      }
      const data = await res.json();
      setFeedItems(data.items || []);
    } catch (err) {
      setFeedError(err.message || "Unable to load subscriptions feed. Showing explore view.");
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
        throw new Error(errJson.error || `Failed to fetch liked videos (${res.status})`);
      }
      const data = await res.json();
      setFeedItems(data.items || []);
    } catch (err) {
      setFeedError(err.message || "Unable to load liked videos. Showing explore view.");
    } finally {
      setFeedLoading(false);
    }
  }, [auth]);

  // Tab switch handler
  const handleTabChange = (tab) => {
    setActiveTab(tab);
    setFeedError(null);
    if (tab === "subscriptions") {
      if (auth?.authenticated) {
        loadSubscriptionsFeed();
      }
    } else if (tab === "liked") {
      if (auth?.authenticated) {
        loadLikedVideos();
      }
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

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!query.trim()) return;

    if (isLikelyYouTubeUrl(query)) {
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
      isYouTube: true
    };
    onSelectYouTubeVideo?.(videoObj);
  };

  // Determine which list to display
  const isPersonalTab = activeTab === "subscriptions" || activeTab === "liked";
  const hasPersonalFeed = isPersonalTab && auth?.authenticated && !feedError && feedItems.length > 0;
  const showFallbackToExplore = isPersonalTab && (!auth?.authenticated || feedError);
  const displayedItems = hasPersonalFeed ? feedItems : results;

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
          📺 Subscriptions Feed
        </button>
        <button
          type="button"
          className={`youtube-tab-btn ${activeTab === "liked" ? "active" : ""}`}
          onClick={() => handleTabChange("liked")}
        >
          👍 Liked Videos
        </button>
      </div>

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
          Paste any YouTube link or search for videos. All streams are decoded via WebCodecs onto a canvas
          so you can drive in your Tesla without video pausing.
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
              placeholder="Paste YouTube link (e.g. youtu.be/...) or search terms..."
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

          {isLikelyYouTubeUrl(query) ? (
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
        </form>

        <div className="youtube-chips-row">
          <span className="youtube-chip-label">Quick topics:</span>
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
              : "Sign in with your Google account to stream uploads from your favorite creators. Showing popular explore videos below in the meantime:"}
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

      {/* Loading states */}
      {(isLoading || feedLoading) && (
        <div className="youtube-status-msg">
          <div className="youtube-spinner" />
          <p>
            {feedLoading
              ? "Fetching your YouTube feed & metadata..."
              : "Searching YouTube & fetching video metadata..."}
          </p>
        </div>
      )}

      {/* Error state for explore */}
      {error && !isLoading && !isPersonalTab && (
        <div className="youtube-status-msg">
          <p style={{ color: "#ff4d4f", marginBottom: "0.75rem" }}>{error}</p>
          <button
            type="button"
            className="youtube-action-btn primary"
            onClick={() => performSearch(query || "Lofi Hip Hop")}
          >
            Retry Search
          </button>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !feedLoading && displayedItems.length === 0 && !error && (
        <div className="youtube-status-msg">
          <p>No YouTube videos found. Try a different search query or paste a direct video link.</p>
        </div>
      )}

      {/* Grid of videos */}
      {!isLoading && !feedLoading && displayedItems.length > 0 && (
        <div className="youtube-grid">
          {displayedItems.map((item) => {
            const videoId = `yt_${item.id}`;
            const isPlaying = currentVideoId === videoId;
            const isFav = Boolean(favorites[videoId]);

            return (
              <div
                key={item.id}
                className={`youtube-card ${isPlaying ? "active-playing" : ""}`}
                onClick={() => handleCardClick(item)}
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
                  <div className="youtube-card-author">{item.author}</div>

                  <div className="youtube-card-footer">
                    <span className="youtube-card-badge">WebCodecs Stream</span>
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
          })}
        </div>
      )}
    </div>
  );
}
