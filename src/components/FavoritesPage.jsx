import React, { useMemo, useState } from "react";

function formatDuration(seconds) {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return "";
  }
  const total = Math.floor(seconds);
  if (total <= 0) return "";
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function getDownloadFilename(video) {
  if (!video?.src) return "video.mp4";
  try {
    const cleanSrc = video.src.split("?")[0];
    const lastSegment = cleanSrc.split("/").filter(Boolean).pop();
    if (lastSegment) {
      return decodeURIComponent(lastSegment);
    }
  } catch {
    // Fallback to title
  }
  return `${video.title || "video"}.mp4`;
}

function getDownloadUrl(video) {
  if (!video?.src) return "";
  return `${video.src}${video.src.includes("?") ? "&" : "?"}download=1`;
}

function formatAddedDate(timestamp) {
  if (!timestamp) return "Saved to Favorites";
  const diffMs = Date.now() - timestamp;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Added just now";
  if (diffMins < 60) return `Added ${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `Added ${diffHrs}h ago`;
  const date = new Date(timestamp);
  return `Added ${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined
  })}`;
}

export default function FavoritesPage({
  favoriteItems = [],
  watchProgress = {},
  currentVideoId,
  onSelectVideo,
  onToggleFavorite,
  onClearFavorites,
  onNavigateHome
}) {
  const [favSearch, setFavSearch] = useState("");
  const [sortBy, setSortBy] = useState("RECENT");
  const [courseFilter, setCourseFilter] = useState("ALL");
  const [confirmClear, setConfirmClear] = useState(false);
  const [failedPosters, setFailedPosters] = useState({});

  const courses = useMemo(() => {
    const set = new Set();
    for (const item of favoriteItems) {
      if (item.video.course) set.add(item.video.course);
    }
    return Array.from(set);
  }, [favoriteItems]);

  const filteredAndSortedItems = useMemo(() => {
    const q = favSearch.trim().toLowerCase();
    const filtered = favoriteItems.filter(({ video }) => {
      if (courseFilter !== "ALL" && video.course !== courseFilter) return false;
      if (!q) return true;
      return (
        video.title.toLowerCase().includes(q) ||
        (video.description && video.description.toLowerCase().includes(q)) ||
        (video.course && video.course.toLowerCase().includes(q)) ||
        (video.section && video.section.toLowerCase().includes(q))
      );
    });

    return [...filtered].sort((a, b) => {
      if (sortBy === "TITLE") {
        return a.video.title.localeCompare(b.video.title, undefined, {
          numeric: true
        });
      }
      if (sortBy === "OLDEST") {
        return (a.addedAt || 0) - (b.addedAt || 0);
      }
      return (b.addedAt || 0) - (a.addedAt || 0);
    });
  }, [favoriteItems, favSearch, sortBy, courseFilter]);

  const handlePosterError = (videoId) => {
    setFailedPosters((prev) =>
      prev[videoId] ? prev : { ...prev, [videoId]: true }
    );
  };

  const heroVideo = filteredAndSortedItems[0]?.video || favoriteItems[0]?.video;

  const handlePlayAll = () => {
    if (filteredAndSortedItems.length > 0) {
      onSelectVideo(filteredAndSortedItems[0].video);
    }
  };

  const handleShufflePlay = () => {
    if (filteredAndSortedItems.length > 0) {
      const randomIndex = Math.floor(Math.random() * filteredAndSortedItems.length);
      onSelectVideo(filteredAndSortedItems[randomIndex].video);
    }
  };

  return (
    <div className="subpage-container favorites-page">
      <aside className="favorites-hero-panel">
        <div className="favorites-hero-card">
          <div
            className="favorites-hero-thumb"
            onClick={heroVideo ? handlePlayAll : undefined}
            style={{ cursor: heroVideo ? "pointer" : "default" }}
          >
            {heroVideo?.poster && !failedPosters[heroVideo.id] ? (
              <img
                src={heroVideo.poster}
                alt={heroVideo.title}
                onError={() => handlePosterError(heroVideo.id)}
              />
            ) : (
              <div className="favorites-hero-placeholder">
                <svg width="54" height="54" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                </svg>
              </div>
            )}
            {heroVideo && (
              <div className="favorites-hero-overlay">
                <span>▶ Play All</span>
              </div>
            )}
          </div>

          <div className="favorites-hero-info">
            <h2>Favorites</h2>
            <p className="favorites-hero-stats">
              {favoriteItems.length}{" "}
              {favoriteItems.length === 1 ? "video" : "videos"} • Saved locally
            </p>
            <p className="favorites-hero-desc">
              Your personal collection of bookmarked lessons and favorite streams.
            </p>

            {favoriteItems.length > 0 && (
              <div className="favorites-hero-buttons">
                <button
                  type="button"
                  className="btn-primary-action"
                  onClick={handlePlayAll}
                >
                  ▶ Play All
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleShufflePlay}
                >
                  🔀 Shuffle
                </button>
              </div>
            )}

            {favoriteItems.length > 0 && (
              <div className="favorites-hero-manage">
                {!confirmClear ? (
                  <button
                    type="button"
                    className="text-danger-btn"
                    onClick={() => setConfirmClear(true)}
                  >
                    Clear all favorites
                  </button>
                ) : (
                  <div className="confirm-clear-box">
                    <p>Remove all videos from Favorites?</p>
                    <div className="confirm-clear-actions">
                      <button
                        type="button"
                        className="btn-danger-solid"
                        onClick={() => {
                          onClearFavorites();
                          setConfirmClear(false);
                        }}
                      >
                        Remove All
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => setConfirmClear(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </aside>

      <div className="favorites-main-col">
        {favoriteItems.length === 0 ? (
          <div className="empty-state-card">
            <div className="empty-state-icon" aria-hidden="true">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
              </svg>
            </div>
            <h3>No favorites saved yet</h3>
            <p>
              Click the <strong>♡ Favorite</strong> button on the video player or any video card to bookmark your favorite videos here.
            </p>
            <button
              type="button"
              className="btn-primary-action"
              onClick={onNavigateHome}
            >
              Explore Library
            </button>
          </div>
        ) : (
          <>
            <div className="favorites-toolbar">
              <div className="history-search-box favorites-search-box">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="search"
                  placeholder="Search favorites..."
                  aria-label="Search favorites"
                  value={favSearch}
                  onChange={(e) => setFavSearch(e.target.value)}
                />
              </div>

              <div className="favorites-filters">
                {courses.length > 1 && (
                  <select
                    className="filter-select"
                    value={courseFilter}
                    onChange={(e) => setCourseFilter(e.target.value)}
                    aria-label="Filter favorites by course"
                  >
                    <option value="ALL">All Courses ({courses.length})</option>
                    {courses.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                )}

                <select
                  className="filter-select"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  aria-label="Sort favorites"
                >
                  <option value="RECENT">Sort: Recently Added</option>
                  <option value="OLDEST">Sort: Oldest Added</option>
                  <option value="TITLE">Sort: Title (A–Z)</option>
                </select>
              </div>
            </div>

            {filteredAndSortedItems.length === 0 ? (
              <div className="empty-state-card">
                <h3>No matching favorites</h3>
                <p>Try clearing your search or course filter.</p>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setFavSearch("");
                    setCourseFilter("ALL");
                  }}
                >
                  Reset Filters
                </button>
              </div>
            ) : (
              <div className="favorites-list">
                {filteredAndSortedItems.map(({ video, addedAt }, index) => {
                  const isActive = video.id === currentVideoId;
                  const progress = watchProgress[video.id];
                  const watchedSeconds = progress?.time > 0 ? progress.time : 0;
                  const watchedLabel = formatDuration(watchedSeconds);
                  const totalDurationLabel = formatDuration(progress?.duration);
                  const isCompleted = Boolean(
                    progress?.completed ||
                      (progress?.duration > 0 &&
                        watchedSeconds >= progress.duration - 1.5)
                  );
                  const progressPercent =
                    progress?.duration > 0
                      ? Math.min(
                          100,
                          Math.max(
                            watchedSeconds > 0 ? 2 : 0,
                            Math.round((watchedSeconds / progress.duration) * 100)
                          )
                        )
                      : watchedSeconds > 0
                        ? 5
                        : 0;
                  const displayDuration =
                    watchedLabel && totalDurationLabel
                      ? `${watchedLabel} / ${totalDurationLabel}`
                      : totalDurationLabel || video.duration;

                  return (
                    <article
                      key={video.id}
                      className={`history-card favorite-card ${isActive ? "active" : ""}`}
                      onClick={() => onSelectVideo(video)}
                    >
                      <span className="favorite-index" aria-hidden="true">
                        {index + 1}
                      </span>

                      <div className="history-card-thumb card-thumb">
                        {video.poster && !failedPosters[video.id] ? (
                          <>
                            <img
                              src={video.poster}
                              alt={video.title}
                              loading="lazy"
                              decoding="async"
                              onError={() => handlePosterError(video.id)}
                            />
                            <div className="thumb-overlay" aria-hidden="true">
                              <span className="thumb-play-icon">▶</span>
                            </div>
                          </>
                        ) : (
                          <svg
                            width="42"
                            height="42"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="var(--accent)"
                            strokeWidth="1.5"
                          >
                            <polygon points="5 3 19 12 5 21 5 3" />
                          </svg>
                        )}
                        {isActive && <span className="playing-pill">Playing</span>}
                        {!isActive && isCompleted && (
                          <span className="watched-pill">✓ Watched</span>
                        )}
                        {displayDuration && (
                          <span className="duration-pill">{displayDuration}</span>
                        )}
                        {progressPercent > 0 && (
                          <div className="progress-bar-track">
                            <div
                              className="progress-bar-fill"
                              style={{ width: `${progressPercent}%` }}
                            />
                          </div>
                        )}
                      </div>

                      <div className="history-card-body">
                        <div className="history-card-header">
                          <h4 className="history-card-title" title={video.title}>
                            {video.title}
                          </h4>
                          <div
                            className="history-card-actions"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {video.src && (
                              <a
                                href={getDownloadUrl(video)}
                                download={getDownloadFilename(video)}
                                className="icon-action-btn"
                                title={`Download ${video.title}`}
                                aria-label={`Download ${video.title}`}
                              >
                                ⬇
                              </a>
                            )}
                            <button
                              type="button"
                              className="icon-action-btn fav-btn active"
                              onClick={() => onToggleFavorite(video.id)}
                              title="Remove from Favorites"
                              aria-label={`Remove ${video.title} from Favorites`}
                            >
                              ♥
                            </button>
                          </div>
                        </div>

                        <div className="history-card-meta">
                          {video.course && (
                            <span className="meta-course">{video.course}</span>
                          )}
                          {video.section && video.section !== "Main" && (
                            <>
                              <span className="meta-dot">•</span>
                              <span className="meta-section">{video.section}</span>
                            </>
                          )}
                          <span className="meta-dot">•</span>
                          <span className="meta-time">
                            {formatAddedDate(addedAt)}
                          </span>
                        </div>

                        {video.description && (
                          <p className="history-card-desc">{video.description}</p>
                        )}

                        {watchedLabel && (
                          <div className="history-card-status-row">
                            <span
                              className={`card-watch-progress ${isCompleted ? "completed" : ""}`}
                            >
                              {isCompleted
                                ? `✓ Completed (${totalDurationLabel || watchedLabel})`
                                : `▶ Resume at ${watchedLabel}${
                                    progress?.duration > 0
                                      ? ` (${progressPercent}%)`
                                      : ""
                                  }`}
                            </span>
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

