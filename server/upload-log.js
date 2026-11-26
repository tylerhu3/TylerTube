// Upload audit log: records who (Google user) uploaded what file and when.
// Full records (including IP) live in data/upload-log.json (dev: data/upload-log.dev.json);
// publicUploadLogEntry() strips raw IPs before returning entries via GET /api/upload/logs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_UPLOAD_LOG_FILE = fileURLToPath(new URL("../data/upload-log.json", import.meta.url));
const DEFAULT_MAX_ENTRIES = 1000;

export function publicUploadLogEntry(entry) {
  return {
    id: entry.id,
    uploadedAt: entry.uploadedAt,
    uploadedAtIso: entry.uploadedAtIso,
    user: {
      id: entry.user?.id || "",
      name: entry.user?.name || "",
      email: entry.user?.email || ""
    },
    path: entry.path,
    url: entry.url,
    kind: entry.kind,
    size: entry.size
  };
}

export function createUploadLog(filePath = DEFAULT_UPLOAD_LOG_FILE, {
  now = () => Date.now(),
  maxEntries = DEFAULT_MAX_ENTRIES
} = {}) {
  let entries = null;

  function load() {
    if (entries) return entries;
    entries = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (Array.isArray(parsed?.entries)) {
        entries = parsed.entries.filter((e) => e && typeof e === "object");
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error(`[upload-log] could not read ${filePath}: ${err.message}`);
      }
    }
    return entries;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2));
      fs.renameSync(tmp, filePath);
    } catch (err) {
      console.error(`[upload-log] could not save ${filePath}: ${err.message}`);
    }
  }

  return {
    record({ id = "", user = null, path: filePathRel = "", url = "", kind = "", size = 0, ip = "" }) {
      const all = load();
      // Idempotent for retried /complete requests with the same upload session id.
      if (id) {
        const existing = all.find((e) => e.id === id);
        if (existing) return existing;
      }
      const t = now();
      const entry = {
        id: String(id),
        uploadedAt: t,
        uploadedAtIso: new Date(t).toISOString(),
        user: {
          id: String(user?.id || ""),
          name: String(user?.name || ""),
          email: String(user?.email || "")
        },
        path: String(filePathRel),
        url: String(url),
        kind: String(kind),
        size: Number.isFinite(size) ? size : 0,
        ip: String(ip)
      };
      all.unshift(entry);
      if (all.length > maxEntries) all.length = maxEntries;
      save();
      return entry;
    },

    list({ limit = 100 } = {}) {
      const all = load();
      const n = Number.isInteger(limit) && limit > 0 ? limit : 100;
      return all.slice(0, n);
    }
  };
}
