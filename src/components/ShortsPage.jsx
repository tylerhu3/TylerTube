import React, { useState, useEffect, useCallback } from "react";
import { formatDuration } from "../utils/format";
import { readString, writeString } from "../lib/storage";

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

export default function ShortsPage({
  onSelectShort,
  currentVideoId,
  favorites = {},
  onToggleFavorite
}) {
  const [query, setQuery] = useState(() => readString(LAST_SHORTS_QUERY_KEY, ""));
  const [results, setResults] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isUrlDirectPlaying, setIsUrlDirectPlaying] = useState(false);

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

  // Pre-load initial search if query exists, or default to Trending Shorts
  useEffect(() => {
    const initial = query || "Trending Shorts";
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
        throw new Error(errJson.error || "Failed to resolve YouTube Short");
      }
      const info = await res.json();
      const videoObj = {
        id: `yt_${info.id}`,
        ytId: info.id,
        title: info.title,
        duration: info.duration || 0,
        src: `yt:${info.id}`,
        poster: info.thumbnail,
        course: "YouTube Shorts",
        section: info.author || "YouTube",
        isYouTube: true,
        isShort: true
      };
      onSelectShort?.(videoObj);
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
      course: "YouTube Shorts",
      section: item.author || "YouTube",
      isYouTube: true,
      isShort: true
    };
    onSelectShort?.(videoObj);
  };

  return (
    <div className="shorts-page">
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
          Browse vertical short-form videos or paste any Shorts link. Streamed in real-time to the WebCodecs
          canvas player so you can watch in your Tesla without video pausing while driving.
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

      {isLoading && (
        <div className="youtube-status-msg">
          <div className="youtube-spinner" />
          <p>Fetching YouTube Shorts & stream metadata...</p>
        </div>
      )}

      {error && !isLoading && (
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

      {!isLoading && !error && results.length === 0 && (
        <div className="youtube-status-msg">
          <p>No YouTube Shorts found. Try a different query or paste a direct video link.</p>
        </div>
      )}

      {!isLoading && !error && results.length > 0 && (
        <div className="shorts-grid">
          {results.map((item) => {
            const videoId = `yt_${item.id}`;
            const isPlaying = currentVideoId === videoId;
            const isFav = Boolean(favorites[videoId]);

            return (
              <div
                key={item.id}
                className={`shorts-card ${isPlaying ? "active-playing" : ""}`}
                onClick={() => handleCardClick(item)}
              >
                <div className="shorts-card-thumb-wrap">
                  <img
                    src={item.thumbnail}
                    alt={item.title}
                    className="shorts-card-thumb"
                    loading="lazy"
                  />
                  <span className="shorts-card-badge" aria-hidden="true">
                    ⚡ Short
                  </span>
                  {item.duration > 0 && (
                    <span className="shorts-card-duration">
                      {formatDuration(item.duration)}
                    </span>
                  )}
                </div>

                <div className="shorts-card-content">
                  <div className="shorts-card-title" title={item.title}>
                    {item.title}
                  </div>
                  <div className="shorts-card-author">
                    <span>{item.author}</span>
                  </div>

                  <div className="shorts-card-footer">
                    <span className="youtube-play-pill">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                      {isPlaying ? "Playing" : "Play Short"}
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
                            course: "YouTube Shorts",
                            section: item.author || "YouTube",
                            isYouTube: true,
                            isShort: true
                          };
                          onToggleFavorite(videoId, videoObj);
                        }}
                        aria-label={isFav ? "Remove from favorites" : "Add to favorites"}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill={isFav ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2">
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
