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

function getDateGroupLabel(timestamp) {
  if (!timestamp) return "Earlier";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const startOfWeek = startOfToday - 6 * 86400000;

  if (timestamp >= startOfToday) return "Today";
  if (timestamp >= startOfYesterday) return "Yesterday";
  if (timestamp >= startOfWeek) return "Earlier This Week";
  return "Earlier";
}

function formatWatchedTime(timestamp) {
  if (!timestamp) return "Watched recently";
  const diffMs = Date.now() - timestamp;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Watched just now";
  if (diffMins < 60) return `Watched ${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `Watched ${diffHrs}h ago`;
  const date = new Date(timestamp);
  return `Watched ${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined
  })}`;
}

export default function HistoryPage({
  historyItems = [],
  watchProgress = {},
  favorites = {},
  currentVideoId,
  onSelectVideo,
  onToggleFavorite,
  onRemoveFromHistory,
  onClearHistory,
  onNavigateHome
}) {
  const [historySearch, setHistorySearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [courseFilter, setCourseFilter] = useState("ALL");
  const [confirmClear, setConfirmClear] = useState(false);
  const [failedPosters, setFailedPosters] = useState({});

  const courses = useMemo(() => {
    const set = new Set();
    for (const item of historyItems) {
      if (item.video.course) set.add(item.video.course);
    }
    return Array.from(set);
  }, [historyItems]);

  const filteredItems = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    return historyItems.filter(({ video, progress }) => {
      if (courseFilter !== "ALL" && video.course !== courseFilter) return false;
      const isCompleted = Boolean(
        progress?.completed ||
          (progress?.duration > 0 && progress?.time >= progress.duration - 1.5)
      );
      if (statusFilter === "IN_PROGRESS" && isCompleted) return false;
      if (statusFilter === "COMPLETED" && !isCompleted) return false;
      if (!q) return true;
      return (
        video.title.toLowerCase().includes(q) ||
        (video.description && video.description.toLowerCase().includes(q)) ||
        (video.course && video.course.toLowerCase().includes(q)) ||
        (video.section && video.section.toLowerCase().includes(q))
      );
    });
  }, [historyItems, historySearch, statusFilter, courseFilter]);

  const groupedItems = useMemo(() => {
    const groups = [];
    const groupMap = new Map();
    for (const entry of filteredItems) {
      const label = getDateGroupLabel(entry.progress?.updatedAt);
      if (!groupMap.has(label)) {
        const group = { label, items: [] };
        groupMap.set(label, group);
        groups.push(group);
      }
      groupMap.get(label).items.push(entry);
    }
    return groups;
  }, [filteredItems]);

  const handlePosterError = (videoId) => {
    setFailedPosters((prev) =>
      prev[videoId] ? prev : { ...prev, [videoId]: true }
    );
  };

  const completedCount = useMemo(
    () =>
      historyItems.filter(
        ({ progress }) =>
          progress?.completed ||
          (progress?.duration > 0 && progress?.time >= progress.duration - 1.5)
      ).length,
    [historyItems]
  );

  const inProgressCount = historyItems.length - completedCount;

  return (
    <div className="subpage-container history-page">
      <div className="history-main-col">
        <div className="subpage-header">
          <div className="subpage-title-row">
            <h2>Watch history</h2>
            <span className="badge">
              {filteredItems.length}{" "}
              {filteredItems.length === 1 ? "video" : "videos"}
            </span>
          </div>
          <p className="subpage-subtitle">
            Videos you have watched or started watching across your library
          </p>
        </div>

        {historyItems.length === 0 ? (
          <div className="empty-state-card">
            <div className="empty-state-icon" aria-hidden="true">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                <polyline points="3 3 3 8 8 8" />
                <polyline points="12 7 12 12 15.5 14" />
              </svg>
            </div>
            <h3>No watch history yet</h3>
            <p>
              Videos you watch will show up here with your saved playback position so you can pick up right where you left off.
            </p>
            <button
              type="button"
              className="btn-primary-action"
              onClick={onNavigateHome}
            >
              Browse Library
            </button>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="empty-state-card">
            <h3>No matching videos in your history</h3>
            <p>Try adjusting your search query or status filters.</p>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setHistorySearch("");
                setStatusFilter("ALL");
                setCourseFilter("ALL");
              }}
            >
              Reset Filters
            </button>
          </div>
        ) : (
          <div className="history-groups">
            {groupedItems.map((group) => (
              <section key={group.label} className="history-date-group">
                <h3 className="history-date-heading">{group.label}</h3>
                <div className="history-list">
                  {group.items.map(({ video, progress }) => {
                    const isActive = video.id === currentVideoId;
                    const isFavorited = Boolean(favorites[video.id]);
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
                        className={`history-card ${isActive ? "active" : ""}`}
                        onClick={() => onSelectVideo(video)}
                      >
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
                              <button
                                type="button"
                                className={`icon-action-btn fav-btn ${isFavorited ? "active" : ""}`}
                                onClick={() => onToggleFavorite(video.id)}
                                title={
                                  isFavorited
                                    ? "Remove from Favorites"
                                    : "Save to Favorites"
                                }
                                aria-label={
                                  isFavorited
                                    ? "Remove from Favorites"
                                    : "Save to Favorites"
                                }
                              >
                                {isFavorited ? "♥" : "♡"}
                              </button>
                              <button
                                type="button"
                                className="icon-action-btn remove-btn"
                                onClick={() => onRemoveFromHistory(video.id)}
                                title="Remove from watch history"
                                aria-label={`Remove ${video.title} from watch history`}
                              >
                                ✕
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
                              {formatWatchedTime(progress?.updatedAt)}
                            </span>
                          </div>

                          {video.description && (
                            <p className="history-card-desc">{video.description}</p>
                          )}

                          <div className="history-card-status-row">
                            <span
                              className={`card-watch-progress ${isCompleted ? "completed" : ""}`}
                            >
                              {isCompleted
                                ? `✓ Completed${totalDurationLabel ? ` (${totalDurationLabel})` : ""}`
                                : watchedLabel
                                  ? `▶ Resume at ${watchedLabel}${
                                      progress?.duration > 0
                                        ? ` (${progressPercent}%)`
                                        : ""
                                    }`
                                  : "▶ Started watching"}
                            </span>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      <aside className="history-sidebar">
        <div className="history-sidebar-card">
          <div className="history-search-box">
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
              placeholder="Search watch history"
              aria-label="Search watch history"
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
            />
          </div>

          <div className="history-sidebar-section">
            <h4>Filter by status</h4>
            <div className="history-filter-pills">
              <button
                type="button"
                className={`filter-pill ${statusFilter === "ALL" ? "active" : ""}`}
                onClick={() => setStatusFilter("ALL")}
              >
                All ({historyItems.length})
              </button>
              <button
                type="button"
                className={`filter-pill ${statusFilter === "IN_PROGRESS" ? "active" : ""}`}
                onClick={() => setStatusFilter("IN_PROGRESS")}
              >
                In Progress ({inProgressCount})
              </button>
              <button
                type="button"
                className={`filter-pill ${statusFilter === "COMPLETED" ? "active" : ""}`}
                onClick={() => setStatusFilter("COMPLETED")}
              >
                Completed ({completedCount})
              </button>
            </div>
          </div>

          {courses.length > 1 && (
            <div className="history-sidebar-section">
              <h4>Filter by course</h4>
              <select
                className="filter-select full-width-select"
                value={courseFilter}
                onChange={(e) => setCourseFilter(e.target.value)}
                aria-label="Filter history by course"
              >
                <option value="ALL">All Courses ({courses.length})</option>
                {courses.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="history-sidebar-divider" />

          <div className="history-sidebar-section">
            <h4>Manage history</h4>
            {!confirmClear ? (
              <button
                type="button"
                className="history-action-btn danger-hover"
                disabled={historyItems.length === 0}
                onClick={() => setConfirmClear(true)}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6" />
                  <path d="M14 11v6" />
                </svg>
                Clear all watch history
              </button>
            ) : (
              <div className="confirm-clear-box">
                <p>Clear all watch history and saved resume positions?</p>
                <div className="confirm-clear-actions">
                  <button
                    type="button"
                    className="btn-danger-solid"
                    onClick={() => {
                      onClearHistory();
                      setConfirmClear(false);
                    }}
                  >
                    Clear All
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
        </div>
      </aside>
    </div>
  );
}

