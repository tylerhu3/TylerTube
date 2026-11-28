// Client API helpers for /api/youtube/history* endpoints.

async function requestJson(url, options = {}) {
  const res = await fetch(url, {
    credentials: "same-origin",
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data.code || "";
    throw err;
  }
  return data;
}

export async function fetchYouTubeHistory() {
  return requestJson("/api/youtube/history");
}

export async function recordYouTubeHistoryWatch(item) {
  return requestJson("/api/youtube/history/record", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(item)
  });
}

export async function importYouTubeHistoryItems(items) {
  return requestJson("/api/youtube/history/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items })
  });
}

export async function syncYouTubeHistoryLive({ browser = "", limit = 60 } = {}) {
  const payload = { limit };
  if (browser) payload.browser = browser;
  return requestJson("/api/youtube/history/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function saveYouTubeHistoryCookies(cookies) {
  return requestJson("/api/youtube/history/cookies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cookies })
  });
}

export async function clearYouTubeHistoryCookies() {
  return requestJson("/api/youtube/history/cookies", {
    method: "DELETE"
  });
}

export async function removeYouTubeHistoryItem(videoId) {
  return requestJson(`/api/youtube/history?id=${encodeURIComponent(videoId)}`, {
    method: "DELETE"
  });
}

export async function clearYouTubeHistory(scope = "all") {
  return requestJson(`/api/youtube/history?scope=${encodeURIComponent(scope)}`, {
    method: "DELETE"
  });
}
