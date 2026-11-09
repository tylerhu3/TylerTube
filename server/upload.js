// Upload API: resumable, chunked uploads into public/videos/ plus folder creation. Chunks keep
// each request under Cloudflare's ~100 MB request limit (the site is served through a tunnel).
//
//   GET    /api/upload/auth                  → check the key; limits and free space
//   GET    /api/upload/folders               → { folders: ["Course", "Course/Section", …] }
//   POST   /api/upload/folders  {path}       → create (with parents)
//   POST   /api/upload          {folder,name,size} → start or resume → { id, offset, … }
//   GET    /api/upload/session/:id           → { offset, size, … }
//   PUT    /api/upload/session/:id?offset=N  → append raw bytes → { offset }
//   POST   /api/upload/session/:id/complete  {name?} → validate + move into place
//   DELETE /api/upload/session/:id           → cancel
//   GET    /api/upload/status                → { pendingRebuild } (is the new catalog live yet?)
//
// Every request needs the X-Upload-Key header matching TYLERTUBE_UPLOAD_KEY (or the file
// data/upload-key). With no key configured, uploads are off. Errors are always JSON
// { error, code, … }. Disk side: server/upload-store.js; pure rules: server/upload-rules.js.
import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { clientIp, readJSONBody, sendJSON } from "./http-utils.js";
import { MAX_CHUNK_BYTES, MAX_FOLDER_DEPTH, UploadError, parseUploadRoute } from "./upload-rules.js";
import { computeVideoSignature, readRecordedSignature } from "./video-signature.js";

export const DEFAULT_UPLOAD_KEY_FILE = fileURLToPath(new URL("../data/upload-key", import.meta.url));
const MAX_FAILED_ATTEMPTS = 10;
const FAILED_WINDOW_MS = 15 * 60 * 1000;
const MIN_KEY_LENGTH = 12;
const MAX_TRACKED_IPS = 1000;
const CHUNK_IDLE_TIMEOUT_MS = 60_000;

// Rate-limit bucket for an IP: IPv6 by /64 (one client can rotate addresses inside it).
export function ipBucket(ip) {
  if (!ip.includes(":")) return ip;
  const [head] = ip.split("::");
  const groups = head.split(":").filter(Boolean);
  if (ip.startsWith("::") || groups.length < 4) return ip;
  return `${groups.slice(0, 4).join(":")}::/64`;
}

// Key from TYLERTUBE_UPLOAD_KEY, else the first line of data/upload-key. Read on every request,
// so changing the file needs no restart. "" = uploads off.
export function defaultUploadKey(file = DEFAULT_UPLOAD_KEY_FILE) {
  return () => {
    if (process.env.TYLERTUBE_UPLOAD_KEY) return process.env.TYLERTUBE_UPLOAD_KEY.trim();
    try {
      return fs.readFileSync(file, "utf8").split("\n")[0].trim();
    } catch {
      return "";
    }
  };
}

function keysMatch(given, expected) {
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Production: compare public/videos/ with what the deployed dist/ was built from. Cached briefly
// since it stats every file. Dev: Vite reloads the catalog itself, so it's always live.
export function signatureCatalogStatus(videosDir, { cacheMs = 10_000 } = {}) {
  let cached = null;
  return () => {
    const t = Date.now();
    if (!cached || t - cached.at > cacheMs) {
      const built = readRecordedSignature();
      const current = computeVideoSignature(videosDir).signature;
      cached = { at: t, value: { pendingRebuild: Boolean(built) && built !== current, autoRebuild: Boolean(built) } };
    }
    return cached.value;
  };
}

export function createUploadHandler(store, {
  getKey = defaultUploadKey(),
  catalogStatus = () => ({ pendingRebuild: false, autoRebuild: true }),
  now = () => Date.now(),
  cleanupIntervalMs = 60 * 60 * 1000
} = {}) {
  const failures = new Map(); // ip → { count, since }

  try {
    store.cleanup();
  } catch (err) {
    console.error(`[upload] cleanup failed: ${err.message}`);
  }
  if (cleanupIntervalMs) {
    const timer = setInterval(() => {
      try {
        store.cleanup();
      } catch (err) {
        console.error(`[upload] cleanup failed: ${err.message}`);
      }
    }, cleanupIntervalMs);
    timer.unref?.();
  }

  // Drop expired entries; past MAX_TRACKED_IPS drop the oldest, so memory stays bounded.
  function pruneFailures() {
    const t = now();
    for (const [ip, rec] of failures) {
      if (t - rec.since > FAILED_WINDOW_MS) failures.delete(ip);
    }
    while (failures.size > MAX_TRACKED_IPS) {
      failures.delete(failures.keys().next().value);
    }
  }

  function authorize(req) {
    const expected = getKey();
    if (!expected) {
      throw new UploadError(503, "UPLOADS_DISABLED", "Uploads are turned off on this server. Set TYLERTUBE_UPLOAD_KEY (or put a key in data/upload-key) and retry.");
    }
    if (expected.length < MIN_KEY_LENGTH) {
      throw new UploadError(503, "UPLOADS_DISABLED", `The server's upload key is too short (min ${MIN_KEY_LENGTH} characters), so uploads are off.`);
    }
    const ip = ipBucket(clientIp(req));
    const entry = failures.get(ip);
    if (entry && now() - entry.since > FAILED_WINDOW_MS) failures.delete(ip);
    const current = failures.get(ip);
    if (current && current.count >= MAX_FAILED_ATTEMPTS) {
      const mins = Math.ceil((FAILED_WINDOW_MS - (now() - current.since)) / 60000);
      throw new UploadError(429, "TOO_MANY_ATTEMPTS", `Too many wrong upload keys from your address. Try again in ${mins} min.`);
    }
    const given = req.headers["x-upload-key"];
    if (!given || !keysMatch(given, expected)) {
      if (given) {
        const rec = failures.get(ip) || { count: 0, since: now() };
        rec.count += 1;
        failures.delete(ip);
        failures.set(ip, rec); // re-insert: Map order = least recently failed first
        pruneFailures();
      }
      throw new UploadError(401, "BAD_KEY", given ? "Wrong upload key." : "An upload key is required.");
    }
    failures.delete(ip);
  }

  function methodNotAllowed(allowed) {
    return new UploadError(405, "METHOD_NOT_ALLOWED", `Use ${allowed.join(" or ")} here.`, { allow: allowed });
  }

  async function route(req, res, { action, id }, query) {
    const method = req.method;
    switch (action) {
      case "auth":
        if (method !== "GET") throw methodNotAllowed(["GET"]);
        return sendJSON(res, 200, {
          ok: true,
          freeBytes: store.freeBytes(),
          reserveBytes: store.reserveBytes,
          maxFileBytes: store.maxFileBytes,
          chunkBytes: MAX_CHUNK_BYTES,
          maxFolderDepth: MAX_FOLDER_DEPTH
        });
      case "folders":
        if (method === "GET") return sendJSON(res, 200, { folders: store.listFolders() });
        if (method === "POST") {
          const body = await readJSONBody(req, 16 * 1024);
          const result = store.createFolder(body.path);
          return sendJSON(res, result.created ? 201 : 200, result);
        }
        throw methodNotAllowed(["GET", "POST"]);
      case "status":
        if (method !== "GET") throw methodNotAllowed(["GET"]);
        return sendJSON(res, 200, catalogStatus());
      case "sessions": {
        if (method !== "POST") throw methodNotAllowed(["POST"]);
        const body = await readJSONBody(req, 16 * 1024);
        const session = store.createSession(body);
        return sendJSON(res, session.resumed ? 200 : 201, { ...session, chunkBytes: MAX_CHUNK_BYTES });
      }
      case "session":
        if (method === "GET") return sendJSON(res, 200, store.getSession(id));
        if (method === "DELETE") return sendJSON(res, 200, store.cancel(id));
        if (method === "PUT") {
          const offset = query.has("offset") ? Number(query.get("offset")) : NaN;
          const rawLength = req.headers["content-length"];
          const length = rawLength == null ? null : Number(rawLength);
          // A connection that goes silent (phone switching networks) would otherwise hold the
          // session lock until Nginx gives up; end it so Resume works within a minute.
          req.setTimeout(CHUNK_IDLE_TIMEOUT_MS, () => req.destroy(new Error("idle timeout")));
          return sendJSON(res, 200, await store.writeChunk(id, offset, req, length));
        }
        throw methodNotAllowed(["GET", "PUT", "DELETE"]);
      case "complete": {
        if (method !== "POST") throw methodNotAllowed(["POST"]);
        const body = await readJSONBody(req, 16 * 1024);
        return sendJSON(res, 200, await store.complete(id, body));
      }
      default:
        throw new UploadError(404, "NOT_FOUND", "Unknown upload endpoint.");
    }
  }

  return async function uploadHandler(req, res, next) {
    const [pathname, search = ""] = (req.url || "").split("?");
    const parsed = parseUploadRoute(pathname);
    if (!parsed) {
      if (next) next();
      return false;
    }
    try {
      authorize(req);
      await route(req, res, parsed, new URLSearchParams(search));
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return true;
      }
      // Don't leave an unread body on the connection after an early error.
      const headers = !req.readableEnded ? { Connection: "close" } : {};
      if (err instanceof UploadError) {
        if (err.code === "METHOD_NOT_ALLOWED") headers.Allow = err.extra.allow.join(", ");
        const { allow: _allow, ...extra } = err.extra;
        sendJSON(res, err.status, { error: err.message, code: err.code, ...extra }, headers);
      } else if (err.status) {
        const code = err.status === 413 ? "BODY_TOO_LARGE" : "BAD_REQUEST";
        sendJSON(res, err.status, { error: err.message, code }, headers);
      } else {
        console.error(`[upload] ${req.method} ${pathname}: ${err.stack || err.message}`);
        sendJSON(res, 500, { error: `Unexpected server error: ${err.message}`, code: "SERVER_ERROR" }, headers);
      }
    }
    return true;
  };
}
