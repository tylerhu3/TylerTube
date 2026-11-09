// Pure rules for uploads (server/upload.js): name and folder checks, path containment, chunk
// offsets, free-name suggestions. No I/O except the optional `exists` callback, so it's unit-tested
// directly (tests/upload.test.js).
import path from "node:path";
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "./shared.js";

export const MAX_FOLDER_DEPTH = 3; // Course / Section / Subsection
export const MAX_NAME_BYTES = 200;
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
export const SUBTITLE_EXTENSIONS = new Set([".vtt", ".srt"]);
export const UPLOAD_ID_PATTERN = /^[a-f0-9]{32}$/;

// Thrown for anything the client did wrong or the server can't do. `code` is stable for the
// client; `message` is shown to the user as is.
export class UploadError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// One file or folder name. Returns the normalized name or throws UploadError.
export function validateName(raw, what = "Name") {
  if (typeof raw !== "string") {
    throw new UploadError(400, "INVALID_NAME", `${what} is missing.`);
  }
  const name = raw.normalize("NFC").trim();
  if (!name) throw new UploadError(400, "INVALID_NAME", `${what} is empty.`);
  if (name === "." || name === "..") {
    throw new UploadError(400, "INVALID_NAME", `${what} can't be "${name}".`);
  }
  if (name.startsWith(".")) {
    throw new UploadError(400, "INVALID_NAME", `${what} can't start with a dot (hidden files are ignored by the library).`);
  }
  for (const ch of name) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) {
      throw new UploadError(400, "INVALID_NAME", `${what} contains a control character.`);
    }
  }
  if (/[/\\:]/.test(name)) {
    throw new UploadError(400, "INVALID_NAME", `${what} can't contain / \\ or :.`);
  }
  if (Buffer.byteLength(name, "utf8") > MAX_NAME_BYTES) {
    throw new UploadError(400, "INVALID_NAME", `${what} is too long (max ${MAX_NAME_BYTES} bytes).`);
  }
  return name;
}

// "Course/Section" → ["Course", "Section"]. "" or "/" → [] (the videos root).
export function parseFolderPath(raw) {
  if (raw == null) return [];
  if (typeof raw !== "string") {
    throw new UploadError(400, "INVALID_FOLDER", "Folder must be a string.");
  }
  const segments = raw.split("/").filter((s) => s.trim() !== "");
  if (segments.length > MAX_FOLDER_DEPTH) {
    throw new UploadError(400, "INVALID_FOLDER", `Folders can be at most ${MAX_FOLDER_DEPTH} levels deep.`);
  }
  return segments.map((s) => validateName(s, "Folder name"));
}

// What kind of file this is, by extension; throws for anything the library can't use.
export function classifyFile(name) {
  const ext = path.extname(name).toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (SUBTITLE_EXTENSIONS.has(ext)) return "subtitle";
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  const allowed = [...VIDEO_EXTENSIONS, ...SUBTITLE_EXTENSIONS, ...IMAGE_EXTENSIONS].join(", ");
  throw new UploadError(415, "UNSUPPORTED_TYPE", `"${ext || name}" files aren't supported. Allowed: ${allowed}.`);
}

// Absolute path for segments under root, or throws if it would escape root.
export function resolveInside(root, segments) {
  const base = path.resolve(root);
  const target = path.resolve(base, ...segments);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new UploadError(400, "INVALID_FOLDER", "That path is outside the video library.");
  }
  return target;
}

// True if realTarget (already realpath'd) is root or inside it.
export function isInside(realRoot, realTarget) {
  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
}

// "Clip.mp4" → "Clip (2).mp4", "Clip (3).mp4", … — the first one exists() says is free.
export function suggestFreeName(name, exists, limit = 999) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length).replace(/ \(\d+\)$/, "");
  for (let n = 2; n <= limit; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!exists(candidate)) return candidate;
  }
  return null;
}

export function parseSize(raw, maxFileBytes) {
  const size = Number(raw);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new UploadError(400, "INVALID_SIZE", "File size is missing or invalid (empty files can't be uploaded).");
  }
  if (size > maxFileBytes) {
    throw new UploadError(413, "FILE_TOO_LARGE", `File is larger than the ${formatBytes(maxFileBytes)} upload limit.`);
  }
  return size;
}

// Validates one PUT of `length` bytes at `offset` against a session already holding `current`
// of `size` bytes. `length` may be null when the request has no Content-Length.
export function checkChunk({ offset, current, size, length, maxChunk = MAX_CHUNK_BYTES }) {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new UploadError(400, "INVALID_OFFSET", "Chunk offset is missing or invalid.");
  }
  if (offset !== current) {
    throw new UploadError(409, "OFFSET_MISMATCH", `Server has ${current} bytes, chunk starts at ${offset}.`, { offset: current });
  }
  if (length != null) {
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new UploadError(400, "EMPTY_CHUNK", "Chunk is empty.");
    }
    if (length > maxChunk) {
      throw new UploadError(413, "CHUNK_TOO_LARGE", `Chunk is larger than ${formatBytes(maxChunk)}.`);
    }
    if (offset + length > size) {
      throw new UploadError(400, "CHUNK_PAST_END", "Chunk goes past the declared file size.");
    }
  }
}

// Decides from an ffprobe JSON result whether the file is a usable video. Returns
// { ok, error?, warning?, duration }.
export function evaluateProbe(probe, ext) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === "audio");
  const duration = Number(probe?.format?.duration) || 0;
  if (!video) return { ok: false, error: "The file has no video stream (is it really a video?)." };
  if (!(duration > 0)) return { ok: false, error: "The file's duration couldn't be read; it may be incomplete or damaged." };

  const notes = [];
  const lowerExt = String(ext || "").toLowerCase();
  if (video.codec_name !== "h264" || lowerExt === ".webm" || lowerExt === ".mov") {
    notes.push(`video is ${video.codec_name || "unknown"} in ${lowerExt || "this container"}`);
  }
  if (audio && !["aac", "mp3"].includes(audio.codec_name)) {
    notes.push(`audio is ${audio.codec_name || "unknown"}`);
  }
  const warning = notes.length
    ? `Plays in the WebCodecs player; the Standard player may not play it (${notes.join(", ")}). H.264 + AAC MP4 works everywhere.`
    : undefined;
  return { ok: true, warning, duration };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// Route parsing for /api/upload/… → { action, id? } or null when it isn't an upload route.
export function parseUploadRoute(pathname) {
  if (pathname === "/api/upload") return { action: "sessions" };
  if (!pathname.startsWith("/api/upload/")) return null;
  const rest = pathname.slice("/api/upload/".length).split("/");
  if (rest.length === 1 && ["auth", "folders", "status"].includes(rest[0])) return { action: rest[0] };
  if (rest[0] === "session" && UPLOAD_ID_PATTERN.test(rest[1] || "")) {
    if (rest.length === 2) return { action: "session", id: rest[1] };
    if (rest.length === 3 && rest[2] === "complete") return { action: "complete", id: rest[1] };
  }
  return { action: "unknown" };
}
