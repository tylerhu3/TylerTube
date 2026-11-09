// Presentational pieces of the WebCodecs player chrome (yt-* classes, webcodecs-player.css).
import React from "react";
import { formatPlayerTime } from "./playerUtils";

const ICONS = {
  play: "M8 5v14l11-7z",
  pause: "M6 19h4V5H6v14zm8-14v14h4V5h-4z",
  replay:
    "M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z",
  rewind:
    "M11.99 5V1l-5 5 5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6h-2c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z",
  forward:
    "M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z",
  mute: "M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z",
  volLow: "M7 9v6h4l5 5V4l-5 5H7zm9.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z",
  volHigh:
    "M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z",
  gear: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z",
  theater:
    "M19 6H5c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 10H5V8h14v8z",
  fsExit: "M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z",
  fsEnter: "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"
};

const BEZEL_ICON = { play: ICONS.play, pause: ICONS.pause, mute: ICONS.mute, unmute: ICONS.volHigh };

export function PlayerTopBar({ tag, title, isBuffering, bufferedAheadSec, fps, statusText }) {
  return (
    <div className="yt-top-bar">
      <div className="yt-top-left">
        <span className="yt-drive-tag">{tag}</span>
        <span className="yt-ch-title" title={title}>
          {title}
        </span>
        {isBuffering ? (
          <span className="yt-fps-pill yt-buffering-pill">
            Buffering {bufferedAheadSec.toFixed(1)}s
          </span>
        ) : (
          <span className="yt-fps-pill">{fps} FPS</span>
        )}
        <span className="yt-sub-status">{isBuffering ? "Buffering..." : statusText}</span>
      </div>
    </div>
  );
}

export function BufferingOverlay({ bufferedAheadSec }) {
  return (
    <div className="yt-buffering-overlay">
      <div className="yt-buffering-spinner" />
      <div className="yt-buffering-text">
        Buffering... {bufferedAheadSec > 0 ? `(${bufferedAheadSec.toFixed(1)}s)` : ""}
      </div>
    </div>
  );
}

export function PlayerBezel({ type, bezelKey }) {
  if (!type || !BEZEL_ICON[type]) return null;
  return (
    <div key={bezelKey} className="yt-bezel animate">
      <svg viewBox="0 0 24 24">
        <path d={BEZEL_ICON[type]} />
      </svg>
    </div>
  );
}

export function SkipIndicators({ leftLabel, rightLabel }) {
  return (
    <>
      <div className={`yt-skip-ind left ${leftLabel ? "show" : ""}`}>{leftLabel || "« 10s"}</div>
      <div className={`yt-skip-ind right ${rightLabel ? "show" : ""}`}>
        {rightLabel || "10s »"}
      </div>
    </>
  );
}

export function StatsPanel({ open, lines, onClose }) {
  return (
    <div className={`yt-stats ${open ? "open" : ""}`}>
      <div className="yt-stats-hdr">
        <span>Stats for nerds</span>
        <span className="yt-stats-close" onClick={onClose} role="button" tabIndex={0}>
          ✕
        </span>
      </div>
      <div className="yt-stats-body">
        {lines.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
    </div>
  );
}

// Seek bar; pointer handlers come from the owning player (it owns the drag refs).
export function SeekBar({
  wrapRef,
  isDragging,
  isHovering,
  hoverPct,
  hoverTimeText,
  bufferedPct,
  playedPct,
  handlers
}) {
  return (
    <div ref={wrapRef} className={`yt-progress-wrap ${isDragging ? "dragging" : ""}`} {...handlers}>
      {(isHovering || isDragging) && (
        <div
          className="yt-hover-time"
          style={{ left: `${Math.max(6, Math.min(94, hoverPct))}%`, display: "block" }}
        >
          {hoverTimeText}
        </div>
      )}
      <div className="yt-progress-track">
        <div className="yt-progress-buffered" style={{ width: `${bufferedPct}%` }} />
        <div className="yt-progress-hover" style={{ width: `${hoverPct}%` }} />
        <div className="yt-progress-played" style={{ width: `${playedPct}%` }} />
        <div className="yt-scrubber" style={{ left: `${playedPct}%` }} />
      </div>
    </div>
  );
}

export function ControlBar({
  isPaused,
  isEnded,
  isMuted,
  volumePct,
  displayTime,
  duration,
  syncLabelTxt,
  quality,
  isFullscreen,
  settingsBtnRef,
  volumeLabel,
  onTogglePlay,
  onSkip,
  onToggleMute,
  onSetVolume,
  onAdjustSync,
  onResetSync,
  onToggleSettings,
  onToggleTheater,
  onToggleFullscreen,
  onSwitchToStandard
}) {
  const volIcon = isMuted || volumePct === 0 ? ICONS.mute : volumePct < 50 ? ICONS.volLow : ICONS.volHigh;
  return (
    <div className="yt-bar">
      <div className="yt-left">
        <button type="button" className="yt-btn" onClick={onTogglePlay} title="Play/Pause (k)">
          <svg viewBox="0 0 24 24">
            <path d={isEnded ? ICONS.replay : isPaused ? ICONS.play : ICONS.pause} />
          </svg>
        </button>
        <button type="button" className="yt-btn" onClick={() => onSkip(-10)} title="Rewind 10 seconds (j)">
          <svg viewBox="0 0 24 24">
            <path d={ICONS.rewind} />
          </svg>
        </button>
        <button type="button" className="yt-btn" onClick={() => onSkip(10)} title="Forward 10 seconds (l)">
          <svg viewBox="0 0 24 24">
            <path d={ICONS.forward} />
          </svg>
        </button>
        <div className="yt-vol-wrap">
          <button type="button" className="yt-btn" onClick={onToggleMute} title="Mute/Unmute">
            <svg viewBox="0 0 24 24">
              <path d={volIcon} />
            </svg>
          </button>
          <input
            type="range"
            className="yt-vol-slider"
            min="0"
            max="300"
            value={volumePct}
            onChange={(e) => onSetVolume(Number(e.target.value) / 100)}
            title={`Volume ${volumePct}%`}
            aria-label={volumeLabel}
          />
        </div>
        <span className="yt-time">
          {formatPlayerTime(displayTime)}
          {duration > 0 ? ` / ${formatPlayerTime(duration)}` : ""}
        </span>
      </div>

      <div className="yt-right">
        <div className="yt-sync-group">
          <button type="button" className="yt-pill-btn" onClick={() => onAdjustSync(-0.1)} title="Delay video (-100ms)">
            -0.1s
          </button>
          <button type="button" className="yt-pill-btn" onClick={onResetSync} title="Reset A/V sync offset">
            Sync: {syncLabelTxt}
          </button>
          <button type="button" className="yt-pill-btn" onClick={() => onAdjustSync(0.1)} title="Advance video (+100ms)">
            +0.1s
          </button>
        </div>
        <button ref={settingsBtnRef} type="button" className="yt-btn" onClick={onToggleSettings} title="Settings">
          {quality >= 720 && <span className="yt-hd-badge">HD</span>}
          <svg viewBox="0 0 24 24">
            <path d={ICONS.gear} />
          </svg>
        </button>
        {onToggleTheater && (
          <button type="button" className="yt-btn" onClick={onToggleTheater} title="Theater mode (t)">
            <svg viewBox="0 0 24 24">
              <path d={ICONS.theater} />
            </svg>
          </button>
        )}
        <button type="button" className="yt-btn" onClick={onToggleFullscreen} title="Full screen (f)">
          <svg viewBox="0 0 24 24">
            <path d={isFullscreen ? ICONS.fsExit : ICONS.fsEnter} />
          </svg>
        </button>
        {onSwitchToStandard && (
          <button
            type="button"
            className="yt-standard-btn"
            onClick={onSwitchToStandard}
            title="Switch back to Standard Player (D)"
          >
            Use Standard Player
          </button>
        )}
      </div>
    </div>
  );
}
