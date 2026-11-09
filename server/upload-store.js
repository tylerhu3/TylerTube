// Disk side of uploads (server/upload.js): folders, resumable upload sessions, the free-space
// guard, ffprobe validation and the final no-overwrite move into public/videos/.
//
// Sessions live in public/videos/.uploads/ (<id>.part + <id>.json). The dot keeps them out of
// the catalog, the thumbnail generator and the rebuild signature, and being on the same disk as
// the library makes the final move a hard link (instant, and it fails rather than overwrites).
// The .part file's size is the source of truth for how much has arrived.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  MAX_CHUNK_BYTES,
  MAX_FOLDER_DEPTH,
  UPLOAD_ID_PATTERN,
  UploadError,
  checkChunk,
  classifyFile,
  evaluateProbe,
  formatBytes,
  isInside,
  parseFolderPath,
  parseSize,
  resolveInside,
  suggestFreeName,
  validateName
} from "./upload-rules.js";
import { encodeUrlPath } from "./shared.js";

export const UPLOADS_DIRNAME = ".uploads";
export const DEFAULT_RESERVE_BYTES = 5 * 1024 ** 3; // always leave 5 GB free
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 ** 3;
export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// A session untouched this long no longer reserves disk space and may be replaced by a
// different file with the same name (it was likely abandoned: tab closed, cancel lost).
export const SESSION_IDLE_MS = 5 * 60 * 1000;
const RESERVE_ACTIVE_MS = 30 * 60 * 1000;
// Finished uploads keep a small record so a retried "complete" whose first reply was lost
// (tunnel timeout, dropped connection) gets the result instead of a 404.
const DONE_RECORD_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ACTIVE_SESSIONS = 20;
const PROBE_TIMEOUT_MS = 120_000;

// ffprobe → parsed JSON. Rejects with UploadError when ffprobe itself can't run.
export function ffprobeJSON(file) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && err.code === "ENOENT") {
          reject(new UploadError(500, "PROBE_UNAVAILABLE", "ffprobe isn't installed on the server, so the video can't be checked. Your upload is kept; retry once it's fixed."));
          return;
        }
        if (err && err.killed) {
          reject(new UploadError(500, "PROBE_TIMEOUT", "Checking the video took too long. Your upload is kept; try finishing it again."));
          return;
        }
        // ffprobe exits non-zero for files it can't parse: that's a bad file, not a server fault.
        if (err) {
          // Last line, without the server-side path ffprobe prefixes it with.
          const line = String(stderr || err.message).trim().split("\n").pop();
          resolve({ unreadable: true, message: line.split(`${file}: `).join("") });
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve({ unreadable: true, message: "ffprobe returned unreadable output" });
        }
      }
    );
  });
}

function defaultFreeBytes(dir) {
  const st = fs.statfsSync(dir);
  return Number(st.bavail) * Number(st.bsize);
}

export function createUploadStore({
  videosDir,
  reserveBytes = DEFAULT_RESERVE_BYTES,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  probe = ffprobeJSON,
  freeBytes = defaultFreeBytes,
  now = () => Date.now(),
  log = (msg) => console.log(`[upload] ${msg}`)
}) {
  const root = path.resolve(videosDir);
  const uploadsDir = path.join(root, UPLOADS_DIRNAME);
  const busy = new Set(); // session ids with a write/complete in flight

  const partPath = (id) => path.join(uploadsDir, `${id}.part`);
  const metaPath = (id) => path.join(uploadsDir, `${id}.json`);
  const donePath = (id) => path.join(uploadsDir, `${id}.done.json`);

  function readDone(id) {
    if (!UPLOAD_ID_PATTERN.test(String(id))) return null;
    try {
      return JSON.parse(fs.readFileSync(donePath(id), "utf8"));
    } catch {
      return null;
    }
  }

  function realRoot() {
    try {
      return fs.realpathSync(root);
    } catch {
      throw new UploadError(500, "LIBRARY_MISSING", `The video library folder (${root}) doesn't exist on the server.`);
    }
  }

  // Existing folder for segments, resolved and checked against symlinks pointing outside.
  function existingFolder(segments) {
    const target = resolveInside(root, segments);
    let real;
    try {
      real = fs.realpathSync(target);
    } catch {
      throw new UploadError(404, "FOLDER_NOT_FOUND", `Folder "${segments.join("/") || "/"}" doesn't exist (anymore). Pick or create a folder again.`);
    }
    if (!isInside(realRoot(), real)) {
      throw new UploadError(400, "INVALID_FOLDER", "That folder points outside the video library.");
    }
    if (!fs.statSync(real).isDirectory()) {
      throw new UploadError(409, "NOT_A_FOLDER", `"${segments.join("/")}" is a file, not a folder.`);
    }
    return target;
  }

  function ensureUploadsDir() {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  function checkFreeSpace(needed, what) {
    let free;
    try {
      free = freeBytes(root);
    } catch (err) {
      throw new UploadError(500, "DISK_CHECK_FAILED", `Couldn't check free disk space: ${err.message}`);
    }
    if (free - needed < reserveBytes) {
      throw new UploadError(
        507,
        "DISK_FULL",
        `Not enough disk space for ${what}: ${formatBytes(free)} free, needs ${formatBytes(needed)} plus ${formatBytes(reserveBytes)} kept in reserve.`,
        { freeBytes: free }
      );
    }
    return free;
  }

  function readMeta(id) {
    if (!UPLOAD_ID_PATTERN.test(String(id))) return null;
    try {
      return JSON.parse(fs.readFileSync(metaPath(id), "utf8"));
    } catch {
      return null;
    }
  }

  function writeMeta(meta) {
    const tmp = `${metaPath(meta.id)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(meta));
    fs.renameSync(tmp, metaPath(meta.id));
  }

  function partSize(id) {
    try {
      return fs.statSync(partPath(id)).size;
    } catch {
      return null;
    }
  }

  function loadSession(id) {
    const done = readDone(id);
    if (done) {
      throw new UploadError(409, "ALREADY_COMPLETE", `This upload already finished as "${done.result.path}".`, { result: done.result });
    }
    const meta = readMeta(id);
    const offset = meta ? partSize(id) : null;
    if (!meta || offset == null) {
      throw new UploadError(404, "SESSION_NOT_FOUND", "This upload no longer exists on the server (it was cancelled, finished, or expired after 24 h). Start it again.");
    }
    return { meta, offset };
  }

  function removeSession(id) {
    for (const file of [partPath(id), metaPath(id), `${metaPath(id)}.tmp`]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // already gone
      }
    }
  }

  function listSessions() {
    let names;
    try {
      names = fs.readdirSync(uploadsDir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const meta = readMeta(name.slice(0, -5));
      if (meta) out.push({ meta, offset: partSize(meta.id) ?? 0 });
    }
    return out;
  }

  function publicSession({ meta, offset }) {
    return { id: meta.id, folder: meta.folder, name: meta.name, size: meta.size, offset };
  }

  function lock(id) {
    if (busy.has(id)) {
      throw new UploadError(409, "BUSY", "This upload is already being written by another request. Wait a moment and retry.");
    }
    busy.add(id);
    return () => busy.delete(id);
  }

  return {
    root,
    reserveBytes,
    maxFileBytes,

    freeBytes() {
      return freeBytes(root);
    },

    // Every folder under the library (not files), up to MAX_FOLDER_DEPTH, hidden ones skipped.
    listFolders() {
      realRoot();
      const out = [];
      const walk = (dir, rel, depth) => {
        if (depth >= MAX_FOLDER_DEPTH) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
          const relPath = rel ? `${rel}/${entry.name}` : entry.name;
          out.push(relPath);
          walk(path.join(dir, entry.name), relPath, depth + 1);
        }
      };
      walk(root, "", 0);
      return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    },

    createFolder(rawPath) {
      const segments = parseFolderPath(rawPath);
      if (segments.length === 0) {
        throw new UploadError(400, "INVALID_FOLDER", "Enter a folder name.");
      }
      const target = resolveInside(root, segments);
      // Deepest existing ancestor must really be inside the library (no symlink escapes).
      let existing = target;
      while (!fs.existsSync(existing)) existing = path.dirname(existing);
      if (!isInside(realRoot(), fs.realpathSync(existing))) {
        throw new UploadError(400, "INVALID_FOLDER", "That folder points outside the video library.");
      }
      const folder = segments.join("/");
      if (existing === target) {
        if (!fs.statSync(target).isDirectory()) {
          throw new UploadError(409, "NOT_A_FOLDER", `"${folder}" already exists as a file.`);
        }
        return { path: folder, created: false };
      }
      try {
        fs.mkdirSync(target, { recursive: true });
      } catch (err) {
        throw new UploadError(500, "MKDIR_FAILED", `Couldn't create "${folder}": ${err.message}`);
      }
      log(`created folder ${folder}`);
      return { path: folder, created: true };
    },

    // Starts an upload, or resumes the unfinished one for the same folder + name + size.
    // lastModified (the browser File's, optional) must also match to resume, so a different
    // file with the same name and size never gets spliced onto an old partial upload.
    createSession({ folder: rawFolder, name: rawName, size: rawSize, lastModified: rawLastModified }) {
      const segments = parseFolderPath(rawFolder);
      const name = validateName(rawName, "File name");
      const kind = classifyFile(name);
      const size = parseSize(rawSize, maxFileBytes);
      const folder = segments.join("/");
      const dir = existingFolder(segments);
      const lastModified = Number.isSafeInteger(rawLastModified) ? rawLastModified : null;

      const sessions = listSessions();
      const resumable = sessions.find(
        (s) =>
          s.meta.folder === folder &&
          s.meta.name === name &&
          s.meta.size === size &&
          (s.meta.lastModified ?? null) === lastModified
      );
      if (resumable) {
        resumable.meta.updatedAt = now();
        writeMeta(resumable.meta);
        return { ...publicSession(resumable), resumed: true };
      }

      // Same target, different file: the old partial upload is abandoned; start over.
      const others = [];
      for (const s of sessions) {
        if (s.meta.folder === folder && s.meta.name === name) {
          if (busy.has(s.meta.id) || now() - (s.meta.updatedAt || 0) < SESSION_IDLE_MS) {
            const mins = Math.ceil(SESSION_IDLE_MS / 60000);
            throw new UploadError(
              409,
              "BUSY",
              `A different "${name}" is being uploaded to this folder (another tab or device). Wait for it, or retry in ${mins} min if it was abandoned.`
            );
          }
          removeSession(s.meta.id);
          log(`replaced stale ${s.meta.id} (${name}): a different file was picked`);
        } else {
          others.push(s);
        }
      }
      if (fs.existsSync(path.join(dir, name))) {
        const suggestion = suggestFreeName(name, (n) => fs.existsSync(path.join(dir, n)));
        throw new UploadError(409, "NAME_TAKEN", `"${name}" already exists in ${folder || "the library root"}.`, { suggestion });
      }
      if (others.length >= MAX_ACTIVE_SESSIONS) {
        throw new UploadError(429, "TOO_MANY_UPLOADS", `There are already ${others.length} unfinished uploads. Finish or cancel some first.`);
      }
      // Only recently active uploads reserve space; abandoned ones don't block new uploads.
      const pending = others
        .filter((s) => now() - (s.meta.updatedAt || 0) < RESERVE_ACTIVE_MS)
        .reduce((sum, s) => sum + Math.max(0, s.meta.size - s.offset), 0);
      checkFreeSpace(size + pending, `"${name}" (${formatBytes(size)})`);

      ensureUploadsDir();
      const id = crypto.randomBytes(16).toString("hex");
      const meta = { id, folder, name, size, lastModified, kind, createdAt: now(), updatedAt: now() };
      fs.writeFileSync(partPath(id), "", { flag: "wx" });
      writeMeta(meta);
      log(`start ${id} → ${folder ? `${folder}/` : ""}${name} (${formatBytes(size)})`);
      return { ...publicSession({ meta, offset: 0 }), resumed: false };
    },

    getSession(id) {
      const done = readDone(id);
      if (done) return { id, offset: done.size, size: done.size, done: true, result: done.result };
      return publicSession(loadSession(id));
    },

    // Appends the request body at `offset`. On any failure the .part file is cut back to
    // `offset`, so a chunk is either fully written or not at all.
    async writeChunk(id, offset, body, contentLength) {
      const unlock = lock(id);
      try {
        const { meta, offset: current } = loadSession(id);
        checkChunk({ offset, current, size: meta.size, length: contentLength });
        const limit = Math.min(contentLength ?? MAX_CHUNK_BYTES, meta.size - offset);
        checkFreeSpace(limit, "this chunk");

        // Bytes past `limit` are read and dropped (not errored mid-stream), so the request is
        // fully consumed and the client actually receives the error reply.
        let written = 0;
        let overflow = false;
        const counter = new Transform({
          transform(chunk, _enc, cb) {
            if (overflow) return cb();
            const room = limit - written;
            if (chunk.length > room) {
              overflow = true;
              written += Math.max(0, room);
              return cb(null, room > 0 ? chunk.subarray(0, room) : undefined);
            }
            written += chunk.length;
            cb(null, chunk);
          }
        });
        try {
          await pipeline(body, counter, fs.createWriteStream(partPath(id), { flags: "a" }));
          if (overflow) {
            throw new UploadError(400, "CHUNK_PAST_END", "Chunk is larger than declared or goes past the end of the file.");
          }
          if (written === 0) throw new UploadError(400, "EMPTY_CHUNK", "Chunk is empty.");
          if (contentLength != null && written !== contentLength) {
            throw new UploadError(400, "INCOMPLETE_CHUNK", `Chunk was cut off (${written} of ${contentLength} bytes arrived).`);
          }
        } catch (err) {
          try {
            fs.truncateSync(partPath(id), offset);
          } catch {
            // session removed meanwhile
          }
          if (err instanceof UploadError) throw err;
          if (err.code === "ENOSPC") {
            throw new UploadError(507, "DISK_FULL", "The server's disk filled up while writing. Free some space, then retry.");
          }
          // Client went away mid-chunk (network drop, tab closed): resumable from `offset`.
          throw new UploadError(400, "CHUNK_ABORTED", `Chunk transfer was interrupted (${err.code || err.message}).`);
        }
        meta.updatedAt = now();
        writeMeta(meta);
        return { offset: offset + written, size: meta.size };
      } finally {
        unlock();
      }
    },

    // Checks the finished file and moves it into its folder. `rename` picks a different final
    // name (e.g. the suggestion after a NAME_TAKEN). A file that isn't a usable video is deleted.
    async complete(id, { name: rename } = {}) {
      const done = readDone(id);
      if (done) return done.result; // a retry after a lost reply
      const unlock = lock(id);
      try {
        const { meta, offset } = loadSession(id);
        if (offset !== meta.size) {
          throw new UploadError(409, "INCOMPLETE", `Upload isn't finished (${formatBytes(offset)} of ${formatBytes(meta.size)}).`, { offset });
        }
        let name = meta.name;
        if (rename != null && rename !== meta.name) {
          name = validateName(rename, "File name");
          if (classifyFile(name) !== meta.kind) {
            throw new UploadError(400, "INVALID_NAME", "The new name must keep a matching file type.");
          }
        }
        const segments = parseFolderPath(meta.folder);
        const dir = existingFolder(segments);
        const finalPath = path.join(dir, name);
        const nameTaken = () => {
          const suggestion = suggestFreeName(name, (n) => fs.existsSync(path.join(dir, n)));
          return new UploadError(409, "NAME_TAKEN", `"${name}" was added to ${meta.folder || "the library root"} by someone else meanwhile.`, { suggestion });
        };
        if (fs.existsSync(finalPath)) throw nameTaken();

        let warning;
        if (meta.kind === "video") {
          const probed = await probe(partPath(id));
          const verdict = probed?.unreadable
            ? { ok: false, error: `The file couldn't be read as a video (${probed.message}).` }
            : evaluateProbe(probed, path.extname(name));
          if (!verdict.ok) {
            removeSession(id);
            log(`rejected ${id} (${meta.name}): ${verdict.error}`);
            throw new UploadError(422, "NOT_A_VIDEO", `${verdict.error} The upload was discarded.`);
          }
          warning = verdict.warning;
        }

        try {
          fs.linkSync(partPath(id), finalPath); // fails with EEXIST instead of overwriting
        } catch (err) {
          if (err.code === "EEXIST") throw nameTaken();
          throw new UploadError(500, "MOVE_FAILED", `Couldn't move the file into the library: ${err.message}. Your upload is kept; retry.`);
        }
        const relSegments = [...segments, name];
        const result = {
          path: relSegments.join("/"),
          url: `/videos/${encodeUrlPath(relSegments)}`,
          kind: meta.kind,
          ...(warning ? { warning } : {})
        };
        try {
          fs.writeFileSync(donePath(id), JSON.stringify({ size: meta.size, finishedAt: now(), result }));
        } catch (err) {
          log(`couldn't write done record for ${id}: ${err.message}`);
        }
        removeSession(id);
        log(`done ${id} → ${result.path}`);
        return result;
      } finally {
        unlock();
      }
    },

    cancel(id) {
      if (!readMeta(id) && partSize(id) == null) return { ok: true, existed: false };
      const unlock = lock(id);
      try {
        removeSession(id);
        log(`cancelled ${id}`);
        return { ok: true, existed: true };
      } finally {
        unlock();
      }
    },

    // Deletes sessions untouched for maxAgeMs, plus stray files without a session.
    cleanup(maxAgeMs = SESSION_MAX_AGE_MS) {
      let names;
      try {
        names = fs.readdirSync(uploadsDir);
      } catch {
        return 0;
      }
      let removed = 0;
      const t = now();
      for (const name of names) {
        const id = name.split(".")[0];
        if (busy.has(id)) continue;
        if (name.endsWith(".done.json")) {
          const done = readDone(id);
          let finishedAt = done?.finishedAt;
          if (!finishedAt) {
            try {
              finishedAt = fs.statSync(path.join(uploadsDir, name)).mtimeMs;
            } catch {
              continue;
            }
          }
          if (t - finishedAt > DONE_RECORD_TTL_MS) {
            try {
              fs.unlinkSync(path.join(uploadsDir, name));
              removed += 1;
            } catch {
              // gone
            }
          }
          continue;
        }
        const meta = readMeta(id);
        let stale;
        if (meta) {
          stale = t - (meta.updatedAt || 0) > maxAgeMs;
        } else {
          // No session file: an orphan. Only remove once it's old, so a session being created
          // right now isn't caught between its two writes.
          try {
            stale = t - fs.statSync(path.join(uploadsDir, name)).mtimeMs > 60_000;
          } catch {
            stale = false;
          }
        }
        if (!stale) continue;
        if (meta) removeSession(id);
        else {
          try {
            fs.unlinkSync(path.join(uploadsDir, name));
          } catch {
            // gone
          }
        }
        removed += 1;
      }
      if (removed) log(`cleaned up ${removed} expired upload file(s)`);
      return removed;
    }
  };
}
