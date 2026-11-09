import React from "react";
import { formatDuration } from "../../utils/format";
import { formatBytes } from "../../lib/uploader";

const STATUS_LABELS = {
  queued: "Waiting",
  uploading: "Uploading",
  finishing: "Checking file…",
  done: "Done",
  error: "Failed",
  canceled: "Canceled"
};

function ItemDetail({ item }) {
  if (item.status === "uploading") {
    const pct = item.total ? Math.floor((item.loaded / item.total) * 100) : 0;
    const eta = item.rate > 0 ? formatDuration((item.total - item.loaded) / item.rate) : "";
    return (
      <span>
        {pct}% · {formatBytes(item.loaded)} of {formatBytes(item.total)}
        {item.rate > 0 && ` · ${formatBytes(item.rate)}/s`}
        {eta && ` · ${eta} left`}
      </span>
    );
  }
  if (item.status === "done") {
    if (item.kind !== "video") return <span>Saved next to the videos in this folder.</span>;
    return item.live ? (
      <span>Live in the library. Reload the page to see it.</span>
    ) : (
      <span>Saved. It shows up in the library after the next automatic rebuild (about 2 min).</span>
    );
  }
  return <span>{formatBytes(item.total)}</span>;
}

export default function UploadQueue({ items, onCancel, onRetry, onUseName, onRemove, onClearFinished, onReload }) {
  if (items.length === 0) return null;
  const finishedCount = items.filter((i) => ["done", "canceled", "error"].includes(i.status)).length;
  const anyLive = items.some((i) => i.status === "done" && i.live);

  return (
    <section className="upload-panel upload-queue" aria-label="Upload queue">
      <div className="upload-panel-head">
        <h3>Queue</h3>
        <div className="upload-queue-actions">
          {anyLive && (
            <button type="button" className="upload-link-btn" onClick={onReload}>
              Reload library
            </button>
          )}
          {finishedCount > 0 && (
            <button type="button" className="upload-link-btn" onClick={onClearFinished}>
              Clear finished
            </button>
          )}
        </div>
      </div>
      <ul className="upload-queue-list">
        {items.map((item) => {
          const pct = item.total ? (item.loaded / item.total) * 100 : 0;
          const active = item.status === "uploading" || item.status === "finishing";
          return (
            <li key={item.key} className={`upload-item status-${item.status}`}>
              <div className="upload-item-top">
                <div className="upload-item-name" title={item.name}>{item.name}</div>
                <span className={`upload-status status-${item.status}`}>
                  {item.status === "done" && item.live ? "Live" : STATUS_LABELS[item.status]}
                </span>
              </div>
              <div className="upload-item-dest">→ {item.folder || "Library root"}</div>
              {(active || (item.status === "error" && item.loaded > 0)) && item.total > 0 && (
                <div
                  className="upload-progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.floor(pct)}
                >
                  <div className="upload-progress-fill" style={{ width: `${pct}%` }} />
                </div>
              )}
              <div className="upload-item-detail">
                <ItemDetail item={item} />
              </div>
              {item.retryNote && active && (
                <div className="upload-item-note">{item.retryNote}</div>
              )}
              {item.warning && <div className="upload-warning">{item.warning}</div>}
              {item.error && (
                <div className="upload-error" role="alert">
                  {item.error.message}
                  {item.error.code && <span className="upload-error-code"> [{item.error.code}]</span>}
                </div>
              )}
              <div className="upload-item-buttons">
                {/* Not while "Checking file…": the server finishes that step regardless. */}
                {(item.status === "queued" || item.status === "uploading") && (
                  <button type="button" className="upload-small-btn" onClick={() => onCancel(item.key)}>
                    Cancel
                  </button>
                )}
                {item.status === "error" && item.error?.suggestion && (
                  <button type="button" className="upload-small-btn primary" onClick={() => onUseName(item.key)}>
                    Save as "{item.error.suggestion}"
                  </button>
                )}
                {item.status === "error" && item.canRetry && (
                  <button type="button" className="upload-small-btn primary" onClick={() => onRetry(item.key)}>
                    {item.loaded > 0 ? "Resume" : "Retry"}
                  </button>
                )}
                {!active && item.status !== "queued" && (
                  <button type="button" className="upload-small-btn" onClick={() => onRemove(item.key)}>
                    {item.status === "error" && item.sessionId ? "Discard" : "Remove"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
