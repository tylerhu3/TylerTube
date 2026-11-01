import React, { useEffect, useRef, useState } from "react";

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

export default function VideoGrid({
  videos,
  courses = [],
  sections = [],
  selectedCourse = "ALL",
  selectedSection = "ALL",
  filterWatchStatus = "ALL",
  onCourseChange,
  onSectionChange,
  onFilterWatchStatusChange,
  currentVideoId,
  watchProgress = {},
  onSelectVideo
}) {
  const activeCardRef = useRef(null);
  const [failedPosters, setFailedPosters] = useState({});

  const hasAnyWatchProgress = Object.values(watchProgress).some(
    (entry) => entry && entry.time > 0
  );

  const handlePosterError = (videoId) => {
    setFailedPosters((prev) =>
      prev[videoId] ? prev : { ...prev, [videoId]: true }
    );
  };

  useEffect(() => {
    if (activeCardRef.current) {
      activeCardRef.current.scrollIntoView({
        block: "nearest",
        behavior: "smooth"
      });
    }
  }, [currentVideoId]);

  return (
    <section className="gallery-section">
      <div className="gallery-header">
        <div className="gallery-title-group">
          <h3>Library</h3>
          <span className="badge">
            {videos.length} {videos.length === 1 ? "video" : "videos"}
          </span>
        </div>

        {(courses.length > 1 || hasAnyWatchProgress || filterWatchStatus !== "ALL") && (
          <div className="filter-bar">
            {courses.length > 1 && (
              <select
                className="filter-select"
                value={selectedCourse}
                onChange={(e) => onCourseChange(e.target.value)}
                aria-label="Filter by course folder"
              >
                <option value="ALL">All Courses ({courses.length})</option>
                {courses.map((course) => (
                  <option key={course} value={course}>
                    {course}
                  </option>
                ))}
              </select>
            )}

            {courses.length > 1 && sections.length > 1 && (
              <select
                className="filter-select"
                value={selectedSection}
                onChange={(e) => onSectionChange(e.target.value)}
                aria-label="Filter by section subfolder"
              >
                <option value="ALL">All Sections ({sections.length})</option>
                {sections.map((section) => (
                  <option key={section} value={section}>
                    {section}
                  </option>
                ))}
              </select>
            )}

            {(hasAnyWatchProgress || filterWatchStatus !== "ALL") &&
              onFilterWatchStatusChange && (
                <select
                  className="filter-select"
                  value={filterWatchStatus}
                  onChange={(e) => onFilterWatchStatusChange(e.target.value)}
                  aria-label="Filter by watch progress"
                >
                  <option value="ALL">All Status</option>
                  <option value="IN_PROGRESS">Continue Watching</option>
                  <option value="WATCHED">Completed</option>
                </select>
              )}
          </div>
        )}
      </div>

      <div className="video-grid">
        {videos.map((video) => {
          const isActive = video.id === currentVideoId;
          const progress = watchProgress[video.id];
          const watchedSeconds = progress?.time > 0 ? progress.time : 0;
          const watchedLabel = formatDuration(watchedSeconds);
          const totalDurationLabel = formatDuration(progress?.duration);
          const isCompleted = Boolean(
            progress?.completed ||
              (progress?.duration > 0 && watchedSeconds >= progress.duration - 1.5)
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
              ref={isActive ? activeCardRef : null}
              className={`video-card ${isActive ? "active" : ""}`}
              onClick={() => onSelectVideo(video)}
            >
              <div className="card-thumb">
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
                <span className="duration-pill">{displayDuration}</span>
                {progressPercent > 0 && (
                  <div className="progress-bar-track">
                    <div
                      className="progress-bar-fill"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                )}
              </div>
              <div className="card-body">
                <div className="card-title-row">
                  <div className="card-title" title={video.title}>
                    {video.title}
                  </div>
                  {video.src && (
                    <a
                      href={getDownloadUrl(video)}
                      download={getDownloadFilename(video)}
                      className="card-download-btn"
                      onClick={(e) => e.stopPropagation()}
                      title={`Download ${video.title}`}
                      aria-label={`Download ${video.title}`}
                    >
                      ⬇
                    </a>
                  )}
                </div>
                {video.section && video.section !== "Main" && (
                  <div className="card-folder" title={video.section}>
                    {video.section}
                  </div>
                )}
                <div className="card-sub" title={video.course || video.description}>
                  {video.course || video.description}
                </div>
                {watchedLabel && (
                  <div
                    className={`card-watch-progress ${isCompleted ? "completed" : ""}`}
                    title={
                      isCompleted
                        ? `Watched (${watchedLabel}${totalDurationLabel ? ` / ${totalDurationLabel}` : ""})`
                        : `Resume at ${watchedLabel}${totalDurationLabel ? ` of ${totalDurationLabel}` : ""}`
                    }
                  >
                    {isCompleted
                      ? `✓ Completed (${totalDurationLabel || watchedLabel})`
                      : `▶ Resume at ${watchedLabel}${
                          progress?.duration > 0 ? ` (${progressPercent}%)` : ""
                        }`}
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}


