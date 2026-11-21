import React, { useState, useEffect, useCallback, useRef } from "react";
import { formatDuration } from "../utils/format";
import { readString, writeString } from "../lib/storage";

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
  onToggleFavorite
}) {
  const [query, setQuery] = useState(() => readString(LAST_QUERY_KEY, ""));
  const [results, setResults] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isUrlDirectPlaying, setIsUrlDirectPlaying] = useState(false);
  const searchTimeoutRef = useRef(null);

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

  // Pre-load initial search if query exists, or default to a relaxing preset
  useEffect(() => {
    const initial = query || "Lofi Hip Hop";
    performSearch(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      performSearch(query);
    }
  };

  const handleChipClick = (topic) => {
    setQuery(topic);
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

  return (
    <div className="youtube-page">
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

      {isLoading && (
        <div className="youtube-status-msg">
          <div className="youtube-spinner" />
          <p>Searching YouTube & fetching video metadata...</p>
        </div>
      )}

      {error && !isLoading && (
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

      {!isLoading && !error && results.length === 0 && (
        <div className="youtube-status-msg">
          <p>No YouTube videos found. Try a different search query or paste a direct video link.</p>
        </div>
      )}

      {!isLoading && !error && results.length > 0 && (
        <div className="youtube-grid">
          {results.map((item) => {
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
                </div>

                <div className="youtube-card-content">
                  <div className="youtube-card-title" title={item.title}>
                    {item.title}
                  </div>
                  <div className="youtube-card-author">
                    <span>{item.author}</span>
                  </div>

                  <div className="youtube-card-footer">
                    <span className="youtube-play-pill">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                      {isPlaying ? "Now Playing" : "Stream to Canvas"}
                    </span>

                    {onToggleFavorite && (
                      <button
                        type="button"
                        className="card-favorite-btn"
                        style={{ background: "none", border: "none", cursor: "pointer", color: isFav ? "#ff4d4f" : "var(--text-muted)" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          const videoObj = {
                            id: videoId,
                            ytId: item.id,
                            title: item.title,
                            duration: item.duration || 0,
                            src: `yt:${item.id}`,
                            poster: item.thumbnail,
                            course: "YouTube",
                            section: item.author || "YouTube",
                            isYouTube: true
                          };
                          onToggleFavorite(videoId, videoObj);
                        }}
                        aria-label={isFav ? "Remove from favorites" : "Add to favorites"}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill={isFav ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2">
                          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                        </svg>
                      </button>
                    )}
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
