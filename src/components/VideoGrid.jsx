import React from "react";

function formatDuration(seconds) {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export default function VideoGrid({
  videos,
  courses = [],
  sections = [],
  selectedCourse = "ALL",
  selectedSection = "ALL",
  onCourseChange,
  onSectionChange,
  currentVideoId,
  watchProgress,
  onSelectVideo
}) {
  return (
    <section className="gallery-section">
      <div className="gallery-header">
        <div className="gallery-title-group">
          <h3>Library</h3>
          <span className="badge">
            {videos.length} {videos.length === 1 ? "video" : "videos"}
          </span>
        </div>

        {courses.length > 1 && (
          <div className="filter-bar">
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

            {sections.length > 1 && (
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
          </div>
        )}
      </div>

      <div className="video-grid">
        {videos.map((video) => {
          const isActive = video.id === currentVideoId;
          const progress = watchProgress[video.id];
          const progressPercent =
            progress?.duration > 0
              ? Math.min(100, Math.round((progress.time / progress.duration) * 100))
              : 0;
          const displayDuration =
            formatDuration(progress?.duration) || video.duration;

          return (
            <article
              key={video.id}
              className={`video-card ${isActive ? "active" : ""}`}
              onClick={() => onSelectVideo(video)}
            >
              <div className="card-thumb">
                {video.poster ? (
                  <img src={video.poster} alt={video.title} loading="lazy" />
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
                <div className="card-title" title={video.title}>
                  {video.title}
                </div>
                {video.section && video.section !== "Main" && (
                  <div className="card-folder" title={video.section}>
                    {video.section}
                  </div>
                )}
                <div className="card-sub" title={video.course || video.description}>
                  {video.course || video.description}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}


