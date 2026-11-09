// Client side of the visitor log (server/visitors.js). Every call fails silently: an old
// server without /api/visit just means no visitor list.
import { readString, writeString } from "./storage.js";

// keys: { idKey, nameKey } — localStorage keys, defined at the top of App.jsx.
// name: pass a string to set/clear this visitor's name; omit to keep the server's.
// Resolves to this visitor ({ id, name, device, … }) or null.
export async function recordVisit(keys, name) {
  const body = { id: readString(keys.idKey, undefined) };
  const localName = name !== undefined ? name : readString(keys.nameKey, "");
  if (localName || name !== undefined) body.name = localName;
  try {
    const res = await fetch("/api/visit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store"
    });
    if (!res.ok) return null;
    const { id, visitor } = await res.json();
    if (typeof id === "string") writeString(keys.idKey, id);
    if (visitor && typeof visitor.name === "string") writeString(keys.nameKey, visitor.name);
    return visitor || null;
  } catch {
    return null;
  }
}

export async function fetchVisitors() {
  try {
    const res = await fetch("/api/visitors", { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data?.visitors) ? data.visitors : null;
  } catch {
    return null;
  }
}

// "just now", "5 min ago", "3 h ago", "2 d ago", then a date.
export function formatLastSeen(timestamp, now = Date.now()) {
  const diff = Math.max(0, now - timestamp);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(timestamp).toLocaleDateString();
}
