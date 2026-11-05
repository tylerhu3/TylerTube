// Shared constants/helpers for the dev/preview server (see CLAUDE.md)

export const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v"]);
export const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
export const MIME_TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".vtt": "text/vtt; charset=utf-8",
  ".srt": "text/plain; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};
export const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base"
});

export function encodeUrlPath(segments) {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}
