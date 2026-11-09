// WebCodecs player constants and pure helpers (no React, unit-tested in tests/).
export const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
export const QUALITY_OPTIONS = [360, 480, 720, 1080];

export function formatPlayerTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const sStr = s < 10 ? "0" + s : "" + s;
  if (h > 0) {
    const mStr = m < 10 ? "0" + m : "" + m;
    return `${h}:${mStr}:${sStr}`;
  }
  return `${m}:${sStr}`;
}

export const BUFFER_OPTIONS = [
  { label: "1s (Fast)", target: 1.0 },
  { label: "2s (Normal)", target: 2.0 },
  { label: "5s (Mobile / Deep)", target: 5.0 }
];

// Frame-rate setting: "auto" (adaptive), "source" (every source frame, max 60) or a cap.
// The server never outputs more than the source rate, whatever is chosen. Default is a 24 fps
// cap (DEFAULT_FPS_SETTING); "auto" stays selectable.
export const FPS_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "source", label: "Source" },
  { value: 60, label: "60" },
  { value: 30, label: "30" },
  { value: 24, label: "24" }
];

// Used when nothing (or an unknown value) is stored.
export const DEFAULT_FPS_SETTING = 24;

// Stored setting string → option value (DEFAULT_FPS_SETTING when missing/unknown).
export function parseFpsSetting(raw) {
  const str = String(raw ?? "").trim();
  for (const opt of FPS_OPTIONS) {
    if (String(opt.value) === str) return opt.value;
  }
  return DEFAULT_FPS_SETTING;
}

// 30 → "30", 29.97003 → "29.97", 0/unknown → "".
export function formatFps(fps) {
  const f = Number(fps);
  if (!(f > 0)) return "";
  if (Math.abs(f - Math.round(f)) < 0.01) return String(Math.round(f));
  return String(Math.round(f * 100) / 100);
}
