// Shared display formatting helpers.

// Seconds → "mm:ss" or "h:mm:ss"; "" for missing/zero/invalid values.
export function formatDuration(seconds) {
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

// Compact view count: 1234 -> "1.2K views", 2500000 -> "2.5M views", 0/invalid -> "".
export function formatViewCount(views) {
  const num = Number(views);
  if (!Number.isFinite(num) || num <= 0) return "";
  if (num >= 1_000_000_000) {
    return `${(num / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B views`;
  }
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, "")}M views`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1).replace(/\.0$/, "")}K views`;
  }
  return `${Math.floor(num)} views`;
}
