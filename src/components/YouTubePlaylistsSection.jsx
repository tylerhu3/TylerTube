import React, { useState, useEffect } from "react";
import { formatDuration, formatViewCount } from "../utils/format";
import { getGoogleLoginUrl } from "../lib/auth";

export function ActivePlaylistBar({
  activePlaylist,
  currentVideoId,
  isShuffled,
  onToggleShuffle,
  onPrev,
  onNext,
  onSelectTrack,
  onClose
}) {
  const [queueOpen, setQueueOpen] = useState(false);

  if (!activePlaylist || !Array.isArray(activePlaylist.items) || activePlaylist.items.length === 0) {
    return null;
  }

  const currentRawId = String(currentVideoId || "").replace(/^yt_/, "");
  const currentIdx = activePlaylist.items.findIndex((item) => item.id === currentRawId);
  const trackLabel =
    currentIdx >= 0
      ? `Track ${currentIdx + 1} / ${activePlaylist.items.length}`
      : `${activePlaylist.items.length} videos`;

  return (
    <div className="youtube-active-playlist-bar">
      <div className="youtube-active-playlist-head">
        <div className="youtube-active-playlist-info">
          <span className="youtube-active-playlist-badge">📋 Playlist Queue</span>
          <strong className="youtube-active-playlist-title" title={activePlaylist.title}>
            {activePlaylist.title}
          </strong>
          <span className="youtube-active-playlist-count">{trackLabel}</span>
        </div>

        <div className="youtube-active-playlist-controls">
          <button
            type="button"
            className="youtube-shelf-btn"
            onClick={onPrev}
            title="Previous video in playlist"
          >
            ⏮ Prev
          </button>
          <button
            type="button"
            className="youtube-shelf-btn"
            onClick={onNext}
            title="Next video in playlist"
          >
            Next ⏭
          </button>
          <button
            type="button"
            className={`youtube-shelf-btn ${isShuffled ? "is-active" : ""}`}
            onClick={onToggleShuffle}
            title={isShuffled ? "Disable shuffle" : "Shuffle playlist"}
          >
            🔀 {isShuffled ? "Shuffled" : "Shuffle"}
          </button>
          <button
            type="button"
            className="youtube-shelf-btn"
            onClick={() => setQueueOpen((prev) => !prev)}
          >
            {queueOpen ? "Hide Queue ▲" : `Queue (${activePlaylist.items.length}) ▼`}
          </button>
          <button
            type="button"
            className="youtube-notice-close-btn"
            onClick={onClose}
            title="Exit playlist queue"
            aria-label="Exit playlist queue"
          >
            ✕
          </button>
        </div>
      </div>

      {queueOpen && (
        <div className="youtube-active-playlist-queue">
          {activePlaylist.items.map((item, idx) => {
            const isCurrent = item.id === currentRawId;
            return (
              <button
                key={`${item.id}_${idx}`}
                type="button"
                className={`youtube-queue-item ${isCurrent ? "is-current" : ""}`}
                onClick={() => onSelectTrack(item)}
              >
                <span className="youtube-queue-index">
                  {isCurrent ? "▶" : idx + 1}
                </span>
                <img
                  src={item.thumbnail || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`}
                  alt={item.title}
                  className="youtube-queue-thumb"
                  loading="lazy"
                />
                <div className="youtube-queue-meta">
                  <div className="youtube-queue-title">{item.title}</div>
                  <div className="youtube-queue-author">
                    {item.author}
                    {item.duration > 0 ? ` · ${formatDuration(item.duration)}` : ""}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function AddToPlaylistModal({
  video,
  customPlaylists,
  onToggleVideoInPlaylist,
  onCreateAndAdd,
  onClose
}) {
  const [newName, setNewName] = useState("");

  useEffect(() => {
    if (!video) return undefined;
    const handleKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [video, onClose]);

  if (!video) return null;

  const rawId = String(video.ytId || video.id || "").replace(/^yt_/, "");

  const handleCreateSubmit = (e) => {
    e.preventDefault();
    const clean = newName.trim();
    if (!clean) return;
    onCreateAndAdd?.(clean, video);
    setNewName("");
  };

  return (
    <div
      className="youtube-playlist-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Add video to playlist"
      onClick={onClose}
    >
      <div
        className="youtube-playlist-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="youtube-playlist-modal-header">
          <h3>Save to Playlist</h3>
          <button
            type="button"
            className="youtube-notice-close-btn"
            onClick={onClose}
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        <div className="youtube-playlist-modal-video">
          <img
            src={video.thumbnail || `https://i.ytimg.com/vi/${rawId}/hqdefault.jpg`}
            alt={video.title}
            className="youtube-playlist-modal-thumb"
          />
          <div className="youtube-playlist-modal-video-info">
            <div className="youtube-playlist-modal-video-title">{video.title}</div>
            <div className="youtube-playlist-modal-video-author">{video.author || "YouTube"}</div>
          </div>
        </div>

        <div className="youtube-playlist-modal-list">
          {customPlaylists.length === 0 ? (
            <p className="youtube-playlist-modal-empty">
              No custom playlists yet. Create your first one below!
            </p>
          ) : (
            customPlaylists.map((pl) => {
              const contains = (pl.items || []).some((item) => item.id === rawId);
              return (
                <button
                  key={pl.id}
                  type="button"
                  className={`youtube-playlist-modal-row ${contains ? "is-added" : ""}`}
                  onClick={() => onToggleVideoInPlaylist?.(pl.id, video, contains)}
                >
                  <span className="youtube-playlist-modal-check">
                    {contains ? "✓" : "+"}
                  </span>
                  <span className="youtube-playlist-modal-name">{pl.title}</span>
                  <span className="youtube-playlist-modal-count">
                    {pl.items?.length || 0} videos
                  </span>
                </button>
              );
            })
          )}
        </div>

        <form onSubmit={handleCreateSubmit} className="youtube-playlist-modal-create">
          <input
            type="text"
            className="youtube-playlist-inline-input"
            placeholder="New playlist name..."
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={80}
          />
          <button
            type="submit"
            className="youtube-action-btn primary youtube-btn-sm"
            disabled={!newName.trim()}
          >
            Create &amp; Add
          </button>
        </form>
      </div>
    </div>
  );
}

export default function YouTubePlaylistsSection({
  auth,
  customPlaylists = [],
  accountPlaylists = [],
  accountPlaylistsLoading = false,
  accountPlaylistsError = null,
  onRefreshAccountPlaylists,
  openedPlaylist = null,
  openedPlaylistLoading = false,
  openedPlaylistError = null,
  onOpenYouTubePlaylist,
  onOpenCustomPlaylist,
  onCloseOpenedPlaylist,
  onCreatePlaylist,
  onRenamePlaylist,
  onDeletePlaylist,
  onSaveRemotePlaylist,
  onRemoveVideoFromPlaylist,
  onMoveVideoInPlaylist,
  onPlayPlaylist,
  currentVideoId,
  favorites = {},
  onToggleFavorite
}) {
  const [playlistUrlInput, setPlaylistUrlInput] = useState("");
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [renameInput, setRenameInput] = useState("");

  useEffect(() => {
    setEditingTitle(false);
    setRenameInput(openedPlaylist?.title || "");
  }, [openedPlaylist?.id, openedPlaylist?.title]);

  const handleLoadUrlSubmit = (e) => {
    e.preventDefault();
    const raw = playlistUrlInput.trim();
    if (!raw) return;
    onOpenYouTubePlaylist?.(raw, { source: "auto" });
  };

  const handleCreateSubmit = (e) => {
    e.preventDefault();
    const name = newPlaylistName.trim();
    if (!name) return;
    onCreatePlaylist?.(name);
    setNewPlaylistName("");
  };

  const handleSaveRename = (e) => {
    e.preventDefault();
    const clean = renameInput.trim();
    if (clean && openedPlaylist?.id) {
      onRenamePlaylist?.(openedPlaylist.id, clean);
    }
    setEditingTitle(false);
  };

  // Detail View when a playlist is opened or loading
  if (openedPlaylist || openedPlaylistLoading || openedPlaylistError) {
    const isCustom = openedPlaylist?.source === "custom" || openedPlaylist?.source === "imported";
    const items = openedPlaylist?.items || [];
    const alreadySavedRemote =
      openedPlaylist &&
      !isCustom &&
      customPlaylists.some((pl) => pl.sourcePlaylistId === openedPlaylist.id);

    return (
      <section className="youtube-section-block">
        <div className="youtube-playlist-detail-nav">
          <button
            type="button"
            className="youtube-shelf-btn"
            onClick={onCloseOpenedPlaylist}
          >
            ← All Playlists
          </button>
        </div>

        {openedPlaylistLoading && (
          <div className="youtube-status-msg">
            <div className="youtube-spinner" />
            <p>Loading YouTube playlist videos...</p>
          </div>
        )}

        {!openedPlaylistLoading && openedPlaylistError && (
          <div className="youtube-status-msg">
            <p style={{ color: "#ff4d4f", marginBottom: "0.75rem" }}>{openedPlaylistError}</p>
            <button
              type="button"
              className="youtube-action-btn primary"
              onClick={onCloseOpenedPlaylist}
            >
              Back to Playlists
            </button>
          </div>
        )}

        {!openedPlaylistLoading && !openedPlaylistError && openedPlaylist && (
          <>
            <div className="youtube-playlist-detail-header">
              <div className="youtube-playlist-detail-cover">
                {openedPlaylist.thumbnail ? (
                  <img
                    src={openedPlaylist.thumbnail}
                    alt={openedPlaylist.title}
                    className="youtube-playlist-detail-thumb"
                  />
                ) : (
                  <div className="youtube-playlist-cover-placeholder">📋</div>
                )}
                <span className="youtube-playlist-count-overlay">
                  {items.length} {items.length === 1 ? "video" : "videos"}
                </span>
              </div>

              <div className="youtube-playlist-detail-meta">
                <span className="youtube-playlist-source-badge">
                  {isCustom
                    ? openedPlaylist.source === "imported"
                      ? "Saved YouTube Playlist"
                      : "Custom Playlist"
                    : "YouTube Playlist"}
                </span>

                {editingTitle && isCustom ? (
                  <form onSubmit={handleSaveRename} className="youtube-playlist-rename-form">
                    <input
                      type="text"
                      className="youtube-playlist-inline-input"
                      value={renameInput}
                      onChange={(e) => setRenameInput(e.target.value)}
                      autoFocus
                      maxLength={80}
                    />
                    <button type="submit" className="youtube-action-btn primary youtube-btn-sm">
                      Save
                    </button>
                    <button
                      type="button"
                      className="youtube-shelf-btn"
                      onClick={() => setEditingTitle(false)}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <h3 className="youtube-playlist-detail-title">{openedPlaylist.title}</h3>
                )}

                <p className="youtube-playlist-detail-author">
                  {openedPlaylist.author || "YouTube"} · {items.length}{" "}
                  {items.length === 1 ? "video" : "videos"}
                </p>

                {openedPlaylist.description && (
                  <p className="youtube-playlist-detail-desc">{openedPlaylist.description}</p>
                )}

                <div className="youtube-playlist-detail-actions">
                  <button
                    type="button"
                    className="youtube-action-btn primary youtube-btn-sm"
                    disabled={items.length === 0}
                    onClick={() => onPlayPlaylist?.(openedPlaylist, items[0], { shuffle: false })}
                  >
                    ▶ Play All
                  </button>
                  <button
                    type="button"
                    className="youtube-action-btn surprise youtube-btn-sm"
                    disabled={items.length === 0}
                    onClick={() => {
                      const randomPick = items[Math.floor(Math.random() * items.length)];
                      onPlayPlaylist?.(openedPlaylist, randomPick, { shuffle: true });
                    }}
                  >
                    🔀 Shuffle
                  </button>
                  {!isCustom && (
                    <button
                      type="button"
                      className="youtube-shelf-btn"
                      disabled={alreadySavedRemote}
                      onClick={() => onSaveRemotePlaylist?.(openedPlaylist)}
                    >
                      {alreadySavedRemote ? "✓ Saved to My Playlists" : "＋ Save to My Playlists"}
                    </button>
                  )}
                  {isCustom && (
                    <>
                      <button
                        type="button"
                        className="youtube-shelf-btn"
                        onClick={() => {
                          setRenameInput(openedPlaylist.title);
                          setEditingTitle(true);
                        }}
                      >
                        ✎ Rename
                      </button>
                      <button
                        type="button"
                        className="youtube-shelf-btn youtube-btn-danger"
                        onClick={() => onDeletePlaylist?.(openedPlaylist.id)}
                      >
                        🗑 Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>

            {items.length === 0 ? (
              <div className="youtube-status-msg">
                <p>
                  This playlist has no videos yet. Click the <strong>＋</strong> button on any
                  YouTube video card to add videos here.
                </p>
              </div>
            ) : (
              <div className="youtube-playlist-tracks">
                {items.map((item, idx) => {
                  const videoId = `yt_${item.id}`;
                  const isPlaying = currentVideoId === videoId;
                  const isFav = Boolean(favorites[videoId]);
                  const viewsLabel = formatViewCount(item.viewCount);

                  return (
                    <div
                      key={`${item.id}_${idx}`}
                      className={`youtube-playlist-track-row ${isPlaying ? "active-playing" : ""}`}
                      onClick={() => onPlayPlaylist?.(openedPlaylist, item, { shuffle: false })}
                    >
                      <span className="youtube-playlist-track-num">
                        {isPlaying ? "▶" : idx + 1}
                      </span>

                      <div className="youtube-playlist-track-thumb-wrap">
                        <img
                          src={item.thumbnail || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`}
                          alt={item.title}
                          className="youtube-playlist-track-thumb"
                          loading="lazy"
                        />
                        {item.duration > 0 && (
                          <span className="youtube-playlist-track-dur">
                            {formatDuration(item.duration)}
                          </span>
                        )}
                      </div>

                      <div className="youtube-playlist-track-info">
                        <div className="youtube-playlist-track-title" title={item.title}>
                          {item.title}
                        </div>
                        <div className="youtube-playlist-track-sub">
                          <span>{item.author}</span>
                          {viewsLabel && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{viewsLabel}</span>
                            </>
                          )}
                        </div>
                      </div>

                      <div
                        className="youtube-playlist-track-actions"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {isCustom && (
                          <>
                            <button
                              type="button"
                              className="youtube-track-icon-btn"
                              disabled={idx === 0}
                              onClick={() => onMoveVideoInPlaylist?.(openedPlaylist.id, item.id, "up")}
                              title="Move up"
                              aria-label="Move video up"
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="youtube-track-icon-btn"
                              disabled={idx === items.length - 1}
                              onClick={() =>
                                onMoveVideoInPlaylist?.(openedPlaylist.id, item.id, "down")
                              }
                              title="Move down"
                              aria-label="Move video down"
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className="youtube-track-icon-btn"
                              onClick={() => onRemoveVideoFromPlaylist?.(openedPlaylist.id, item.id)}
                              title="Remove from playlist"
                              aria-label="Remove from playlist"
                            >
                              ✕
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          className={`youtube-fav-btn ${isFav ? "favorited" : ""}`}
                          onClick={() => onToggleFavorite?.(item)}
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
                  );
                })}
              </div>
            )}
          </>
        )}
      </section>
    );
  }

  // Overview View: URL loader + Custom playlists + Google Account playlists
  return (
    <div className="youtube-playlists-overview">
      {/* Quick Action Cards: Load YouTube Playlist URL + Create Custom Playlist */}
      <div className="youtube-playlists-tools-grid">
        <form onSubmit={handleLoadUrlSubmit} className="youtube-playlist-tool-card">
          <h4>🔗 Open Any YouTube Playlist</h4>
          <p>
            Paste any public or unlisted YouTube playlist URL or ID (<code>PL...</code>) to stream
            all videos in order.
          </p>
          <div className="youtube-playlist-tool-row">
            <input
              type="text"
              className="youtube-playlist-inline-input"
              placeholder="https://www.youtube.com/playlist?list=PL..."
              value={playlistUrlInput}
              onChange={(e) => setPlaylistUrlInput(e.target.value)}
            />
            <button
              type="submit"
              className="youtube-action-btn primary youtube-btn-sm"
              disabled={!playlistUrlInput.trim()}
            >
              Load Playlist
            </button>
          </div>
        </form>

        <form onSubmit={handleCreateSubmit} className="youtube-playlist-tool-card">
          <h4>＋ Create Custom Playlist</h4>
          <p>
            Build your own YouTube playlists in TylerTube and add videos from Search, History, or
            Subscriptions.
          </p>
          <div className="youtube-playlist-tool-row">
            <input
              type="text"
              className="youtube-playlist-inline-input"
              placeholder="e.g. Road Trip Mix, Coding Talks..."
              value={newPlaylistName}
              onChange={(e) => setNewPlaylistName(e.target.value)}
              maxLength={80}
            />
            <button
              type="submit"
              className="youtube-action-btn primary youtube-btn-sm"
              disabled={!newPlaylistName.trim()}
            >
              Create
            </button>
          </div>
        </form>
      </div>

      {/* Custom Playlists Section */}
      <section className="youtube-section-block">
        <div className="youtube-section-header">
          <div>
            <h3 className="youtube-section-title">📂 My Playlists</h3>
            <p className="youtube-section-subtitle">
              Custom and saved YouTube playlists stored locally for instant WebCodecs playback.
            </p>
          </div>
        </div>

        {customPlaylists.length === 0 ? (
          <div className="youtube-playlist-empty-card">
            <p>
              No custom playlists yet. Create one above, load a YouTube playlist URL and save it, or
              click <strong>＋</strong> on any video card.
            </p>
          </div>
        ) : (
          <div className="youtube-playlist-grid">
            {customPlaylists.map((pl) => (
              <div
                key={pl.id}
                className="youtube-playlist-card"
                onClick={() => onOpenCustomPlaylist?.(pl.id)}
              >
                <div className="youtube-playlist-card-thumb-wrap">
                  {pl.thumbnail ? (
                    <img
                      src={pl.thumbnail}
                      alt={pl.title}
                      className="youtube-card-thumb"
                      loading="lazy"
                    />
                  ) : (
                    <div className="youtube-playlist-cover-placeholder">📋</div>
                  )}
                  <span className="youtube-playlist-count-overlay">
                    ≡ {pl.items?.length || 0} {pl.items?.length === 1 ? "video" : "videos"}
                  </span>
                </div>
                <div className="youtube-card-content">
                  <h4 className="youtube-card-title" title={pl.title}>
                    {pl.title}
                  </h4>
                  <div className="youtube-card-author">
                    <span>{pl.source === "imported" ? "Saved YouTube Playlist" : "Custom Playlist"}</span>
                  </div>
                  <div className="youtube-card-footer">
                    <button
                      type="button"
                      className="youtube-shelf-btn"
                      disabled={!pl.items?.length}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (pl.items?.length) {
                          onPlayPlaylist?.(pl, pl.items[0], { shuffle: false });
                        }
                      }}
                    >
                      ▶ Play All
                    </button>
                    <button
                      type="button"
                      className="youtube-fav-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeletePlaylist?.(pl.id);
                      }}
                      title="Delete playlist"
                      aria-label={`Delete ${pl.title}`}
                    >
                      🗑
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Signed-in YouTube Account Playlists Section */}
      <section className="youtube-section-block">
        <div className="youtube-section-header">
          <div>
            <h3 className="youtube-section-title">📺 Your YouTube Playlists</h3>
            <p className="youtube-section-subtitle">
              Playlists from your connected Google / YouTube account.
            </p>
          </div>
          {auth?.authenticated && (
            <button
              type="button"
              className="youtube-shelf-btn"
              disabled={accountPlaylistsLoading}
              onClick={onRefreshAccountPlaylists}
            >
              {accountPlaylistsLoading ? "Refreshing..." : "↻ Refresh"}
            </button>
          )}
        </div>

        {!auth?.authenticated ? (
          <div className="youtube-auth-prompt-card">
            <div className="youtube-auth-prompt-header">
              <span>ℹ️</span>
              <span>Sign in to see your YouTube account playlists</span>
            </div>
            <p className="youtube-auth-prompt-desc">
              {auth?.configured === false
                ? "Google OAuth credentials are not configured yet. You can still load any public/unlisted YouTube playlist URL above or create custom playlists."
                : "Sign in with Google to browse and stream your personal YouTube playlists directly in TylerTube."}
            </p>
            {auth?.configured !== false && (
              <div className="youtube-auth-actions-row">
                <a href={getGoogleLoginUrl("youtube")} className="youtube-google-login-btn">
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
        ) : accountPlaylistsLoading ? (
          <div className="youtube-status-msg">
            <div className="youtube-spinner" />
            <p>Fetching your YouTube playlists...</p>
          </div>
        ) : accountPlaylistsError ? (
          <div className="youtube-playlist-empty-card">
            <p style={{ color: "#ff4d4f", marginBottom: "0.5rem" }}>{accountPlaylistsError}</p>
            <button
              type="button"
              className="youtube-shelf-btn"
              onClick={onRefreshAccountPlaylists}
            >
              Retry
            </button>
          </div>
        ) : accountPlaylists.length === 0 ? (
          <div className="youtube-playlist-empty-card">
            <p>No playlists were found on your YouTube account.</p>
          </div>
        ) : (
          <div className="youtube-playlist-grid">
            {accountPlaylists.map((pl) => (
              <div
                key={pl.id}
                className="youtube-playlist-card"
                onClick={() => onOpenYouTubePlaylist?.(pl.id, { source: "api" })}
              >
                <div className="youtube-playlist-card-thumb-wrap">
                  {pl.thumbnail ? (
                    <img
                      src={pl.thumbnail}
                      alt={pl.title}
                      className="youtube-card-thumb"
                      loading="lazy"
                    />
                  ) : (
                    <div className="youtube-playlist-cover-placeholder">📺</div>
                  )}
                  <span className="youtube-playlist-count-overlay">
                    ≡ {pl.itemCount} {pl.itemCount === 1 ? "video" : "videos"}
                  </span>
                </div>
                <div className="youtube-card-content">
                  <h4 className="youtube-card-title" title={pl.title}>
                    {pl.title}
                  </h4>
                  <div className="youtube-card-author">
                    <span>{pl.author || "YouTube"}</span>
                  </div>
                  <div className="youtube-card-footer">
                    <span className="youtube-card-badge">YouTube Account</span>
                    <span className="youtube-play-pill">Open →</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
