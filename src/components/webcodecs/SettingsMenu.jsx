// Settings popup for the WebCodecs player (presentational; state lives in WebCodecsPlayer).
import React from "react";
import { APP_VERSION } from "../../version";
import { SPEED_OPTIONS, QUALITY_OPTIONS, BUFFER_OPTIONS } from "./playerUtils";

export default function SettingsMenu({
  menuRef,
  open,
  playbackSpeed,
  quality,
  bufferMode,
  bufferTarget,
  syncLabelTxt,
  loopEnabled,
  statsOpen,
  onSetSpeed,
  onSetQuality,
  onSetBufferTarget,
  onAdjustSync,
  onResetSync,
  onToggleLoop,
  onToggleStats
}) {
  return (
    <div
      ref={menuRef}
      className={`yt-settings-menu ${open ? "open" : ""}`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="yt-menu-section">
        <div className="yt-menu-label">
          <span>Playback Speed</span>
          <span>{playbackSpeed}x</span>
        </div>
        <div className="yt-chip-row">
          {SPEED_OPTIONS.map((spd) => (
            <button
              key={spd}
              type="button"
              className={`yt-chip ${playbackSpeed === spd ? "active" : ""}`}
              onClick={() => onSetSpeed(spd)}
            >
              {spd}x
            </button>
          ))}
        </div>
      </div>

      <div className="yt-menu-section">
        <div className="yt-menu-label">
          <span>Quality</span>
          <span>
            {quality}p{quality >= 720 ? " HD" : ""}
          </span>
        </div>
        <div className="yt-chip-row">
          {QUALITY_OPTIONS.map((q) => (
            <button
              key={q}
              type="button"
              className={`yt-chip ${quality === q ? "active" : ""}`}
              onClick={() => onSetQuality(q)}
            >
              {q}p
            </button>
          ))}
        </div>
      </div>

      <div className="yt-menu-section">
        <div className="yt-menu-label">
          <span>Buffer Headroom</span>
          <span>
            {bufferMode === "fast"
              ? "1s (Fast)"
              : bufferMode === "deep"
                ? "5s (Mobile / Deep)"
                : "2s (Normal)"}
          </span>
        </div>
        <div className="yt-chip-row">
          {BUFFER_OPTIONS.map((opt) => (
            <button
              key={opt.target}
              type="button"
              className={`yt-chip ${
                bufferTarget === opt.target ? "active" : ""
              }`}
              onClick={() => onSetBufferTarget(opt.target)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="yt-menu-section">
        <div className="yt-menu-label">
          <span>A/V Sync Offset</span>
          <span>{syncLabelTxt}</span>
        </div>
        <div className="yt-chip-row">
          <button
            type="button"
            className="yt-chip"
            onClick={() => onAdjustSync(-0.1)}
          >
            -100ms
          </button>
          <button
            type="button"
            className="yt-chip"
            onClick={onResetSync}
          >
            Reset
          </button>
          <button
            type="button"
            className="yt-chip"
            onClick={() => onAdjustSync(0.1)}
          >
            +100ms
          </button>
        </div>
      </div>

      <div
        className="yt-menu-toggle"
        onClick={onToggleLoop}
        role="button"
        tabIndex={0}
      >
        <span>Loop Video</span>
        <div className={`yt-switch ${loopEnabled ? "on" : ""}`} />
      </div>

      <div
        className="yt-menu-toggle"
        onClick={onToggleStats}
        role="button"
        tabIndex={0}
      >
        <span>Stats for nerds</span>
        <div className={`yt-switch ${statsOpen ? "on" : ""}`} />
      </div>

      <div className="yt-menu-version">
        <span>TylerTube</span>
        <span>{APP_VERSION}</span>
      </div>
    </div>
  );
}
