import React, { useEffect, useRef, useState } from "react";
import WebCodecsPlayer from "./WebCodecsPlayer";

const SIZE_PRESETS = [
  { label: "S", width: 320, title: "Small (320px)" },
  { label: "M", width: 440, title: "Medium (440px)" },
  { label: "L", width: 600, title: "Large (600px)" },
  { label: "XL", width: 780, title: "Extra Large (780px)" }
];

const MIN_WIDTH = 280;
const MAX_WIDTH = 1000;

function clampWidth(w) {
  const maxViewport =
    typeof window !== "undefined" ? Math.max(MIN_WIDTH, window.innerWidth - 32) : MAX_WIDTH;
  return Math.round(Math.min(Math.min(MAX_WIDTH, maxViewport), Math.max(MIN_WIDTH, w)));
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

function formatTimestamp(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export default function VideoPlayer({
  video,
  onEnded,
  onPrev,
  onNext,
  savedTime = 0,
  savedProgress,
  onTimeUpdate,
  onResetProgress,
  isFavorited = false,
  onToggleFavorite,
  isHidden = false,
  isSidePlayer = false,
  onToggleSidePlayer,
  sidePlayerPrefs = { width: 440, side: "right", vertical: "bottom" },
  onUpdateSidePlayerPrefs,
  viewMode = "desktop",
  onToggleTheater,
  onClose,
  shortsPosition = null
}) {
  // Exact last position reported by the WebCodecs player ({ videoId, time }) so re-showing
  // after hiding resumes at sub-second precision.
  const positionRef = useRef({ videoId: null, time: 0 });
  const canvasPlayerRef = useRef(null);
  const sectionRef = useRef(null);
  const shortsStageRef = useRef(null);
  const savedTimeRef = useRef(savedTime);
  savedTimeRef.current = savedTime;
  const onNextRef = useRef(onNext);
  const onPrevRef = useRef(onPrev);
  onNextRef.current = onNext;
  onPrevRef.current = onPrev;
  const [resumedBannerTime, setResumedBannerTime] = useState(0);
  const [isInteracting, setIsInteracting] = useState(false);
  const [autoNextShort, setAutoNextShort] = useState(false);
  const [shortSlideDir, setShortSlideDir] = useState("");
  const dragStateRef = useRef(null);
  const wheelStateRef = useRef({ accum: 0, lockedUntil: 0, resetTimer: null });
  const touchSwipeRef = useRef(null);
  const slideTimerRef = useRef(null);

  const isShortsMode = Boolean(video?.isShort && !isSidePlayer && !isHidden);

  const triggerShortNav = (direction) => {
    setShortSlideDir(direction);
    if (slideTimerRef.current) clearTimeout(slideTimerRef.current);
    slideTimerRef.current = setTimeout(() => setShortSlideDir(""), 260);
    if (direction === "next") onNextRef.current?.();
    else onPrevRef.current?.();
  };

  useEffect(() => {
    const initialSavedTime = Number(savedTimeRef.current) || 0;
    setResumedBannerTime(initialSavedTime > 0 ? initialSavedTime : 0);
  }, [video?.id]);

  // Mouse wheel / trackpad scroll-to-next-short on the Shorts stage (non-passive so page stays anchored)
  useEffect(() => {
    if (!isShortsMode) return;
    const el = shortsStageRef.current;
    if (!el) return;

    const handleWheel = (e) => {
      if (e.target?.closest?.(".yt-settings-menu")) return;
      e.preventDefault();
      const now = Date.now();
      const ws = wheelStateRef.current;
      if (now < ws.lockedUntil) return;

      ws.accum += e.deltaY;
      if (ws.resetTimer) clearTimeout(ws.resetTimer);
      ws.resetTimer = setTimeout(() => {
        ws.accum = 0;
      }, 180);

      if (ws.accum >= 55) {
        ws.accum = 0;
        ws.lockedUntil = now + 550;
        triggerShortNav("next");
      } else if (ws.accum <= -55) {
        ws.accum = 0;
        ws.lockedUntil = now + 550;
        triggerShortNav("prev");
      }
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", handleWheel);
      if (wheelStateRef.current.resetTimer) {
        clearTimeout(wheelStateRef.current.resetTimer);
        wheelStateRef.current.resetTimer = null;
      }
    };
  }, [isShortsMode]);

  // ArrowUp / ArrowDown keyboard navigation while watching Shorts
  useEffect(() => {
    if (!isShortsMode) return;
    const handleKeyDown = (e) => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        triggerShortNav("next");
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        triggerShortNav("prev");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isShortsMode]);

  useEffect(() => {
    return () => {
      if (slideTimerRef.current) clearTimeout(slideTimerRef.current);
    };
  }, []);

  const handleShortsTouchStart = (e) => {
    if (!isShortsMode || e.touches.length !== 1) return;
    if (e.target?.closest?.(".yt-bottom, button, input, a, .yt-settings-menu")) return;
    const t = e.touches[0];
    touchSwipeRef.current = { x: t.clientX, y: t.clientY, time: Date.now() };
  };

  const handleShortsTouchEnd = (e) => {
    const start = touchSwipeRef.current;
    touchSwipeRef.current = null;
    if (!start || !isShortsMode || e.changedTouches.length === 0) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    const dt = Date.now() - start.time;
    if (dt > 700) return;
    if (Math.abs(dy) >= 50 && Math.abs(dy) > Math.abs(dx) * 1.2) {
      if (dy < 0) triggerShortNav("next");
      else triggerShortNav("prev");
    }
  };

  const handlePlayerEnded = () => {
    if (video?.isShort && !autoNextShort) {
      canvasPlayerRef.current?.seekTo(0);
      return;
    }
    onEnded?.();
  };

  const handleRestartFromBeginning = () => {
    canvasPlayerRef.current?.seekTo(0);
    setResumedBannerTime(0);
    if (video?.id && onResetProgress) {
      onResetProgress(video.id);
    }
  };

  const handleJumpToSavedTime = (targetTime) => {
    if (targetTime > 0) {
      canvasPlayerRef.current?.seekTo(targetTime);
    }
  };

  const handleRewind = () => {
    canvasPlayerRef.current?.skipBy(-10);
  };

  const handleForward = () => {
    canvasPlayerRef.current?.skipBy(10);
  };

  const isMobileView = viewMode === "mobile";
  const rawWidth = clampWidth(sidePlayerPrefs?.width || 440);
  const width = isMobileView ? Math.min(rawWidth, 340) : rawWidth;
  const side = sidePlayerPrefs?.side === "left" ? "left" : "right";
  const vertical = sidePlayerPrefs?.vertical === "top" ? "top" : "bottom";
  const offsetX = isMobileView
    ? 12
    : typeof sidePlayerPrefs?.offsetX === "number"
      ? sidePlayerPrefs.offsetX
      : 24;
  const offsetY = isMobileView
    ? vertical === "top"
      ? 64
      : 72
    : typeof sidePlayerPrefs?.offsetY === "number"
      ? sidePlayerPrefs.offsetY
      : vertical === "top"
        ? 76
        : 24;

  // Pointer-captured drag-to-resize handler
  const handleResizePointerDown = (edge) => (e) => {
    if (!isSidePlayer) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsInteracting(true);
    dragStateRef.current = {
      type: "resize",
      edge,
      startX: e.clientX,
      startY: e.clientY,
      startWidth: width,
      startOffsetX: offsetX,
      side
    };
  };

  const handleResizePointerMove = (e) => {
    const state = dragStateRef.current;
    if (!state || state.type !== "resize") return;

    const dx = e.clientX - state.startX;
    // If dragging the left handle, moving left (-dx) widens the player.
    // If dragging the right handle, moving right (+dx) widens the player.
    const deltaWidth = state.edge.includes("left") ? -dx : dx;
    const nextWidth = clampWidth(state.startWidth + deltaWidth);

    onUpdateSidePlayerPrefs?.({ width: nextWidth });
  };

  const handlePointerEnd = (e) => {
    if (dragStateRef.current) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore if not captured
      }
      dragStateRef.current = null;
      setIsInteracting(false);
    }
  };

  // Drag header to reposition floating player
  const handleMovePointerDown = (e) => {
    if (!isSidePlayer) return;
    if (e.target.closest("button") || e.target.closest("input")) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsInteracting(true);
    const rect = sectionRef.current?.getBoundingClientRect();
    dragStateRef.current = {
      type: "move",
      startX: e.clientX,
      startY: e.clientY,
      rectLeft: rect ? rect.left : 0,
      rectTop: rect ? rect.top : 0,
      rectWidth: rect ? rect.width : width,
      rectHeight: rect ? rect.height : 300
    };
  };

  const handleMovePointerMove = (e) => {
    const state = dragStateRef.current;
    if (!state || state.type !== "move") return;

    const dx = e.clientX - state.startX;
    const dy = e.clientY - state.startY;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const newLeft = Math.max(
      12,
      Math.min(vw - state.rectWidth - 12, state.rectLeft + dx)
    );
    const newTop = Math.max(
      68,
      Math.min(vh - state.rectHeight - 12, state.rectTop + dy)
    );

    const centerX = newLeft + state.rectWidth / 2;
    const centerY = newTop + state.rectHeight / 2;

    const nextSide = centerX < vw / 2 ? "left" : "right";
    const nextVertical = centerY < vh / 2 ? "top" : "bottom";

    const nextOffsetX =
      nextSide === "left"
        ? Math.round(newLeft)
        : Math.round(vw - (newLeft + state.rectWidth));
    const nextOffsetY =
      nextVertical === "top"
        ? Math.round(newTop)
        : Math.round(vh - (newTop + state.rectHeight));

    onUpdateSidePlayerPrefs?.({
      side: nextSide,
      vertical: nextVertical,
      offsetX: Math.max(12, nextOffsetX),
      offsetY: Math.max(12, nextOffsetY)
    });
  };

  const handleSwitchSide = () => {
    const nextSide = side === "right" ? "left" : "right";
    onUpdateSidePlayerPrefs?.({
      side: nextSide,
      offsetX: 24
    });
  };

  const handleSwitchVertical = () => {
    const nextVertical = vertical === "bottom" ? "top" : "bottom";
    onUpdateSidePlayerPrefs?.({
      vertical: nextVertical,
      offsetY: nextVertical === "top" ? 76 : 24
    });
  };

  // Canvas player reports go through here so positionRef stays exact.
  const handleCanvasTimeUpdate = (videoId, time, duration, options) => {
    positionRef.current = { videoId, time };
    onTimeUpdate?.(videoId, time, duration, options);
  };

  // Where the canvas player should start (null → falls back to its own savedTime prop).
  const getCanvasStartTime = () => {
    if (!video) return null;
    const pos = positionRef.current;
    return pos.videoId === video.id && pos.time > 0 ? pos.time : null;
  };

  const floatingStyle = isSidePlayer
    ? {
      width: `${width}px`,
      [side]: `${offsetX}px`,
      [vertical]: `${offsetY}px`
    }
    : isHidden
      ? { display: "none" }
      : undefined;

  return (
    <section
      ref={sectionRef}
      className={`player-section ${isSidePlayer ? "floating-player" : ""} ${
        isSidePlayer ? `dock-${side} dock-${vertical}` : ""
      } ${isInteracting ? "is-interacting" : ""} ${isHidden ? "player-hidden" : ""} ${
        isShortsMode ? "shorts-player-mode" : ""
      }`}
      style={floatingStyle}
    >
      {isSidePlayer && (
        <>
          {/* Drag-to-resize handles on edges and corners */}
          <div
            className="resize-handle resize-handle-left"
            onPointerDown={handleResizePointerDown("left")}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            title="Drag to resize player"
          />
          <div
            className="resize-handle resize-handle-right"
            onPointerDown={handleResizePointerDown("right")}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            title="Drag to resize player"
          />
          <div
            className="resize-handle resize-handle-corner-tl"
            onPointerDown={handleResizePointerDown("top-left")}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            title="Drag corner to resize player"
          />
          <div
            className="resize-handle resize-handle-corner-tr"
            onPointerDown={handleResizePointerDown("top-right")}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            title="Drag corner to resize player"
          />
          <div
            className="resize-handle resize-handle-corner-bl"
            onPointerDown={handleResizePointerDown("bottom-left")}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            title="Drag corner to resize player"
          />
          <div
            className="resize-handle resize-handle-corner-br"
            onPointerDown={handleResizePointerDown("bottom-right")}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            title="Drag corner to resize player"
          />

          {/* Floating toolbar header (draggable to move + quick size & side controls) */}
          <div
            className="floating-toolbar"
            onPointerDown={handleMovePointerDown}
            onPointerMove={handleMovePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            title="Drag to move floating player"
          >
            <div className="floating-toolbar-left">
              <span className="drag-grip" aria-hidden="true">
                ⋮⋮
              </span>
              <button
                type="button"
                className="floating-tool-btn"
                onClick={handleSwitchSide}
                title={`Push to ${side === "right" ? "Left" : "Right"} Side`}
              >
                {side === "right" ? "⬅ Left" : "Right ➡"}
              </button>
              <button
                type="button"
                className="floating-tool-btn"
                onClick={handleSwitchVertical}
                title={`Dock to ${vertical === "bottom" ? "Top" : "Bottom"}`}
              >
                {vertical === "bottom" ? "⬆ Top" : "⬇ Bottom"}
              </button>
            </div>

            <div className="floating-size-controls" aria-label="Player size">
              {SIZE_PRESETS.map((preset) => {
                const isActive = Math.abs(width - preset.width) < 30;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    className={`floating-size-btn ${isActive ? "active" : ""}`}
                    onClick={() =>
                      onUpdateSidePlayerPrefs?.({ width: preset.width })
                    }
                    title={preset.title}
                  >
                    {preset.label}
                  </button>
                );
              })}
              <input
                type="range"
                className="floating-size-slider"
                min={MIN_WIDTH}
                max={820}
                value={Math.min(820, width)}
                onChange={(e) =>
                  onUpdateSidePlayerPrefs?.({ width: Number(e.target.value) })
                }
                title={`Resize player (${width}px)`}
                aria-label="Resize side player width"
              />
            </div>

            <button
              type="button"
              className="floating-close-btn"
              onClick={onToggleSidePlayer}
              title="Restore Full Player (S)"
              aria-label="Restore Full Player"
            >
              ⤢ Expand
            </button>
            {onClose && (
              <button
                type="button"
                className="floating-close-btn"
                onClick={onClose}
                title="Close Player"
                aria-label="Close Player"
              >
                ✕
              </button>
            )}
          </div>
        </>
      )}

      <div
        ref={shortsStageRef}
        className={isShortsMode ? "shorts-stage-layout" : undefined}
        onTouchStart={isShortsMode ? handleShortsTouchStart : undefined}
        onTouchEnd={isShortsMode ? handleShortsTouchEnd : undefined}
      >
        <div
          className={`video-wrapper drive-mode-wrapper ${
            isShortsMode ? "shorts-video-wrapper" : ""
          } ${shortSlideDir ? `shorts-slide-${shortSlideDir}` : ""}`}
        >
          <WebCodecsPlayer
            ref={canvasPlayerRef}
            video={video}
            savedTime={savedTime}
            getStartTime={getCanvasStartTime}
            onTimeUpdate={handleCanvasTimeUpdate}
            onEnded={handlePlayerEnded}
            isHidden={isHidden}
            onToggleTheater={onToggleTheater}
          />
        </div>

        {isShortsMode && (
          <div className="shorts-side-rail" aria-label="Shorts navigation">
            <button
              type="button"
              className="shorts-rail-btn"
              onClick={() => triggerShortNav("prev")}
              title="Previous Short (Scroll Up / ↑)"
              aria-label="Previous Short"
            >
              ⬆
            </button>
            {shortsPosition && shortsPosition.total > 0 && (
              <span className="shorts-rail-counter" title={shortsPosition.feedTitle || "Shorts Queue"}>
                {shortsPosition.index + 1} / {shortsPosition.total}
              </span>
            )}
            <button
              type="button"
              className="shorts-rail-btn primary"
              onClick={() => triggerShortNav("next")}
              title="Next Short (Scroll Down / ↓)"
              aria-label="Next Short"
            >
              ⬇
            </button>

            <div className="shorts-rail-divider" />

            {video?.id && onToggleFavorite && (
              <button
                type="button"
                className={`shorts-rail-btn ${isFavorited ? "favorited" : ""}`}
                onClick={() => onToggleFavorite(video.id)}
                title={isFavorited ? "Remove from Favorites" : "Add to Favorites"}
                aria-label="Toggle favorite"
              >
                {isFavorited ? "♥" : "♡"}
              </button>
            )}

            <button
              type="button"
              className={`shorts-rail-btn ${autoNextShort ? "active" : ""}`}
              onClick={() => setAutoNextShort((prev) => !prev)}
              title={
                autoNextShort
                  ? "Auto-Next is ON (advances when Short ends)"
                  : "Loop is ON (repeats Short until you scroll)"
              }
              aria-label="Toggle auto-next or loop"
            >
              {autoNextShort ? "⏭" : "🔁"}
            </button>

            {onClose && (
              <button
                type="button"
                className="shorts-rail-btn"
                onClick={onClose}
                title="Close Shorts Player"
                aria-label="Close Shorts Player"
              >
                ✕
              </button>
            )}

            <span className="shorts-rail-hint">Scroll / Swipe / ↑↓</span>
          </div>
        )}
      </div>

      <div className="player-bar">
        <div className="video-meta">
          <h2 title={video?.title}>{video?.title}</h2>
          <div className="video-meta-subrow">
            <p>{video?.description}</p>
            {(savedTime > 0 || resumedBannerTime > 0) && (
              <div className="watch-resume-badge">
                <span className="watch-resume-text">
                  {savedProgress?.completed
                    ? "✓ Watched"
                    : `Last watched: ${formatTimestamp(savedTime || resumedBannerTime)}${
                      savedProgress?.duration > 0
                        ? ` / ${formatTimestamp(savedProgress.duration)}`
                        : ""
                    }`}
                </span>
                {savedProgress?.completed && resumedBannerTime > 0 && (
                  <button
                    type="button"
                    className="watch-resume-action"
                    onClick={() => handleJumpToSavedTime(resumedBannerTime)}
                    title="Jump to last position"
                  >
                    Jump to {formatTimestamp(resumedBannerTime)}
                  </button>
                )}
                <button
                  type="button"
                  className="watch-resume-action"
                  onClick={handleRestartFromBeginning}
                  title="Reset watch progress and start from 00:00"
                >
                  ↺ Start Over
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="custom-controls">
          <button
            type="button"
            className="ctrl-btn"
            onClick={onPrev}
            title="Previous Video"
          >
            ⏮ Prev
          </button>
          <button
            type="button"
            className="ctrl-btn"
            onClick={handleRewind}
            title="Rewind 10s"
          >
            ↺ -10s
          </button>
          <button
            type="button"
            className="ctrl-btn"
            onClick={handleForward}
            title="Forward 10s"
          >
            +10s ↻
          </button>
          <button
            type="button"
            className="ctrl-btn"
            onClick={onNext}
            title="Next Video"
          >
            Next ⏭
          </button>
          {video?.id && onToggleFavorite && (
            <button
              type="button"
              className={`ctrl-btn fav-ctrl-btn ${isFavorited ? "active" : ""}`}
              onClick={() => onToggleFavorite(video.id)}
              title={isFavorited ? "Remove from Favorites" : "Add to Favorites"}
            >
              {isFavorited ? "♥ Favorited" : "♡ Favorite"}
            </button>
          )}
          {video?.src && (
            <a
              href={getDownloadUrl(video)}
              download={getDownloadFilename(video)}
              className="ctrl-btn download-btn"
              title={`Download ${video?.title || "video"}`}
            >
              ⬇ Download
            </a>
          )}
          <button
            type="button"
            className={`ctrl-btn side-toggle-ctrl ${isSidePlayer ? "active" : ""}`}
            onClick={onToggleSidePlayer}
            title={
              isSidePlayer
                ? "Restore player to top (S)"
                : "Push player to side while browsing library (S)"
            }
          >
            {isSidePlayer ? "⤢ Restore" : "⧉ Push to Side"}
          </button>
          {onClose && (
            <button
              type="button"
              className="ctrl-btn"
              onClick={onClose}
              title="Close player"
            >
              ✕ Close
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
