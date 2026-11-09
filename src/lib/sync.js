// Keeps localStorage in sync with the server copy at /api/state (server/user-state.js).
//
// localStorage stays the source the app reads from; this module only
//   - before first render: sends the local state, writes the merged result back (initialSync),
//   - after a change: pushes again within a few seconds (touch / touchProgress),
//   - when the page is hidden: flushes with sendBeacon,
//   - when it becomes visible again: pulls (pull), so other devices' changes show up.
// Every call fails silently: offline, or an old server without /api/state, just means
// local-only behaviour, as before sync existed.
import { SYNC_FIELDS, mergeStates, sanitizeState, statesEqual } from "./syncMerge.js";
import { readJSON, readString, writeJSON, writeString } from "./storage.js";

const ENDPOINT = "/api/state";
const PUSH_DELAY_MS = 3000;
const INITIAL_TIMEOUT_MS = 1500;

// keys: { progressKey, metaKey, fields: { [name]: { key, json? } } } — localStorage keys,
// defined at the top of App.jsx. metaKey holds { [fieldName]: modifiedAt }.
export function createSyncStore(keys) {
  let pushTimer = null;
  let inFlight = null;

  function readFieldValue(name) {
    const def = keys.fields[name];
    return def.json ? readJSON(def.key, undefined) : readString(def.key, undefined);
  }

  function snapshot() {
    const meta = readJSON(keys.metaKey, {});
    const state = { progress: readJSON(keys.progressKey, {}), fields: {} };
    for (const name of SYNC_FIELDS) {
      if (!keys.fields[name]) continue;
      const value = readFieldValue(name);
      if (value === undefined || value === null) continue;
      state.fields[name] = { value, modifiedAt: Number(meta[name]) || 0 };
    }
    return sanitizeState(state);
  }

  // Write a merged state into localStorage. Returns true if anything local changed.
  function apply(merged) {
    const local = snapshot();
    const next = mergeStates(local, merged);
    if (statesEqual(local, next)) return false;
    writeJSON(keys.progressKey, { ...readJSON(keys.progressKey, {}), ...next.progress });
    const meta = readJSON(keys.metaKey, {});
    for (const [name, field] of Object.entries(next.fields)) {
      const def = keys.fields[name];
      if (!def) continue;
      if (def.json) writeJSON(def.key, field.value);
      else writeString(def.key, field.value);
      meta[name] = field.modifiedAt;
    }
    writeJSON(keys.metaKey, meta);
    return true;
  }

  async function exchange({ timeoutMs } = {}) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = timeoutMs && controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot()),
        signal: controller?.signal,
        cache: "no-store"
      });
      if (!res.ok) return null;
      return sanitizeState(await res.json());
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function pushNow() {
    clearTimeout(pushTimer);
    pushTimer = null;
    if (inFlight) await inFlight;
    inFlight = exchange();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  // Throttle, not debounce: playback reports progress continuously, and a resetting timer
  // would never fire while a video plays. The push reads the latest snapshot when it runs.
  function schedulePush() {
    if (pushTimer) return;
    pushTimer = setTimeout(pushNow, PUSH_DELAY_MS);
  }

  function flushWithBeacon() {
    if (!pushTimer) return;
    clearTimeout(pushTimer);
    pushTimer = null;
    try {
      if (navigator.sendBeacon?.(ENDPOINT, JSON.stringify(snapshot()))) return;
    } catch {
      // Fall through to a keepalive fetch
    }
    fetch(ENDPOINT, { method: "POST", body: JSON.stringify(snapshot()), keepalive: true }).catch(
      () => {}
    );
  }

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushWithBeacon);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushWithBeacon();
    });
  }

  return {
    // Before first render. Resolves (never rejects) within ~INITIAL_TIMEOUT_MS.
    async initialSync() {
      const merged = await exchange({ timeoutMs: INITIAL_TIMEOUT_MS });
      if (merged) apply(merged);
    },
    // Push local, pull merged. Resolves true when localStorage changed (re-read it).
    async pull() {
      const merged = await pushNow();
      return merged ? apply(merged) : false;
    },
    // Call after the user changes a synced field (after or before writing its value).
    touch(name) {
      const meta = readJSON(keys.metaKey, {});
      meta[name] = Date.now();
      writeJSON(keys.metaKey, meta);
      schedulePush();
    },
    // Call after writing progress entries (each carries its own modifiedAt).
    touchProgress() {
      schedulePush();
    }
  };
}
