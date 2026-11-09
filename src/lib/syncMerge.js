// Pure merge rules for the synced user state, shared by the client (src/lib/sync.js) and the
// server (server/user-state.js) so both sides resolve conflicts identically.
//
// Shape:
//   {
//     progress: { [videoId]: { time, duration, completed, watched, hiddenFromHistory,
//                              updatedAt, modifiedAt } },
//     fields:   { [name]: { value, modifiedAt } }   // name ∈ SYNC_FIELDS
//   }
//
// Conflicts are last-write-wins by `modifiedAt` (ms since epoch, the client's clock):
// per video for progress, per field for fields. Nothing is ever deleted by omission, so a
// device that lacks an entry can't wipe it; removals are written as entries (history removal
// = hiddenFromHistory entry, cleared favorites = an empty favorites object).

export const SYNC_FIELDS = ["favorites", "lastVideoId", "theme", "colorTheme"];

const MAX_PROGRESS_ENTRIES = 20000;
const MAX_ID_LENGTH = 1024;
const MAX_FIELD_VALUE_LENGTH = 512 * 1024;

export function emptyState() {
  return { progress: {}, fields: {} };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

// Entries written before sync existed have no modifiedAt; fall back to updatedAt.
export function entryModifiedAt(entry) {
  if (!isPlainObject(entry)) return 0;
  return finiteOr(entry.modifiedAt, finiteOr(entry.updatedAt, 0));
}

function sanitizeProgressEntry(entry) {
  if (!isPlainObject(entry)) return null;
  const time = finiteOr(entry.time, 0);
  const duration = finiteOr(entry.duration, 0);
  return {
    time: Math.max(0, time),
    duration: Math.max(0, duration),
    completed: Boolean(entry.completed),
    watched: Boolean(entry.watched),
    hiddenFromHistory: Boolean(entry.hiddenFromHistory),
    updatedAt: Math.max(0, finiteOr(entry.updatedAt, 0)),
    modifiedAt: Math.max(0, entryModifiedAt(entry))
  };
}

function sanitizeFieldValue(name, value) {
  if (name === "favorites") {
    if (!isPlainObject(value)) return undefined;
    return JSON.stringify(value).length <= MAX_FIELD_VALUE_LENGTH ? value : undefined;
  }
  if (typeof value !== "string" || value.length > MAX_ID_LENGTH) return undefined;
  return value;
}

// Coerce untrusted input (request body, localStorage) into a valid state; drops bad parts.
export function sanitizeState(input) {
  const out = emptyState();
  if (!isPlainObject(input)) return out;

  if (isPlainObject(input.progress)) {
    let count = 0;
    for (const [id, entry] of Object.entries(input.progress)) {
      if (count >= MAX_PROGRESS_ENTRIES) break;
      if (!id || id.length > MAX_ID_LENGTH) continue;
      const clean = sanitizeProgressEntry(entry);
      if (!clean) continue;
      out.progress[id] = clean;
      count += 1;
    }
  }

  if (isPlainObject(input.fields)) {
    for (const name of SYNC_FIELDS) {
      const field = input.fields[name];
      if (!isPlainObject(field)) continue;
      const value = sanitizeFieldValue(name, field.value);
      if (value === undefined) continue;
      out.fields[name] = { value, modifiedAt: Math.max(0, finiteOr(field.modifiedAt, 0)) };
    }
  }

  return out;
}

// Merge two sanitized states. On a tie `base` wins, so re-sending identical data is a no-op.
export function mergeStates(base, incoming) {
  const merged = { progress: { ...base.progress }, fields: { ...base.fields } };
  for (const [id, entry] of Object.entries(incoming.progress)) {
    const current = merged.progress[id];
    if (!current || entryModifiedAt(entry) > entryModifiedAt(current)) {
      merged.progress[id] = entry;
    }
  }
  for (const [name, field] of Object.entries(incoming.fields)) {
    const current = merged.fields[name];
    if (!current || field.modifiedAt > current.modifiedAt) {
      merged.fields[name] = field;
    }
  }
  return merged;
}

export function statesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
