// Drive player constants and pure helpers (no React, unit-tested in tests/).
export const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
export const QUALITY_OPTIONS = [360, 480, 720, 1080];

export function formatDriveTime(sec) {
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
