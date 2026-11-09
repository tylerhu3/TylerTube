// Server-side copy of each user's watch progress, favorites and synced prefs, so they survive a
// change of origin (every new quick-tunnel URL starts with empty localStorage) and follow the
// user across devices. Merge rules live in src/lib/syncMerge.js (shared with the client).
//
//   GET  /api/state  → the profile's state
//   POST /api/state  → body is the client's full local state; merged into the stored one,
//                      persisted, and the merged result returned (so one request both pushes
//                      and pulls).
//
// One profile ("default") until there's a login; pass getProfileId (e.g. a verified Firebase
// uid) to key state per user. Mounted by server/standalone.js (prod) and server/plugin.js (dev).
import fs from "node:fs";
import path from "node:path";
import { emptyState, mergeStates, sanitizeState, statesEqual } from "../src/lib/syncMerge.js";
import { readBody, sendJSON } from "./http-utils.js";

// Re-exported for older imports.
export { readBody, sendJSON };

export const STATE_ROUTE = "/api/state";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const FILE_VERSION = 1;

export function createUserStateStore(filePath) {
  let data = null;

  function load() {
    if (data) return data;
    data = { version: FILE_VERSION, profiles: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed.profiles === "object" && parsed.profiles) {
        for (const [id, state] of Object.entries(parsed.profiles)) {
          data.profiles[id] = sanitizeState(state);
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        // Keep the unreadable file for inspection instead of overwriting it on the next save.
        const aside = `${filePath}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(filePath, aside);
          console.error(`[state] could not read ${filePath} (${err.message}); moved to ${aside}`);
        } catch {
          console.error(`[state] could not read ${filePath}: ${err.message}`);
        }
      }
    }
    return data;
  }

  function save() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, filePath); // atomic: a crash mid-write never leaves a half file
  }

  return {
    get(profileId) {
      return load().profiles[profileId] || emptyState();
    },
    merge(profileId, incoming) {
      const store = load();
      const current = store.profiles[profileId] || emptyState();
      const merged = mergeStates(current, sanitizeState(incoming));
      if (!statesEqual(current, merged)) {
        store.profiles[profileId] = merged;
        save();
      }
      return merged;
    }
  };
}

// Connect-style (req, res, next) handler; `next` is optional (standalone server falls through
// to its own 404).
export function createUserStateHandler(store, { getProfileId = () => "default" } = {}) {
  return async function userStateHandler(req, res, next) {
    const [pathname] = (req.url || "").split("?");
    if (pathname !== STATE_ROUTE) {
      if (next) next();
      return false;
    }

    try {
      const profileId = await getProfileId(req);
      if (!profileId) {
        sendJSON(res, 401, { error: "Not signed in" });
      } else if (req.method === "GET") {
        sendJSON(res, 200, store.get(profileId));
      } else if (req.method === "POST") {
        // Content-Type isn't checked: navigator.sendBeacon posts strings as text/plain.
        let incoming;
        try {
          incoming = JSON.parse(await readBody(req, MAX_BODY_BYTES));
        } catch (err) {
          if (err.status) throw err;
          sendJSON(res, 400, { error: "Invalid JSON" });
          return true;
        }
        sendJSON(res, 200, store.merge(profileId, incoming));
      } else {
        res.writeHead(405, { Allow: "GET, POST" });
        res.end();
      }
    } catch (err) {
      if (!res.headersSent) sendJSON(res, err.status || 500, { error: err.message });
      if (!err.status) console.error(`[state] ${err.stack || err.message}`);
    }
    return true;
  };
}
