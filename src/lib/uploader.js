// Client side of uploads (server/upload.js): a small API client plus the chunked, resumable
// upload loop. No React here, so node --test covers it (tests/uploader.test.js).
//
// Every failure becomes an UploadFailure with a message fit to show the user, a stable `code`,
// and `retryable` (worth trying again as is). Transient failures are retried automatically
// with backoff; after a dropped connection the server's offset is re-read, so a chunk is never
// written twice or skipped.

export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 5; // per request: 1 try + 4 retries
const MAX_OFFSET_RESYNCS = 20;
// BUSY = the server is still holding the session for an earlier, silently dropped request; it
// frees it within about a minute, so wait (without using up retries) for up to ~2 min.
const BUSY_WAIT_MS = 5000;
const MAX_BUSY_WAITS = 24;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const RETRYABLE_CODES = new Set([
  "NETWORK",
  "BAD_GATEWAY",
  "CHUNK_ABORTED",
  "INCOMPLETE_CHUNK",
  "BUSY",
  "PROBE_TIMEOUT"
]);

export class UploadFailure extends Error {
  constructor(message, { code = "UNKNOWN", status = 0, retryable = false, ...extra } = {}) {
    super(message);
    this.name = "UploadFailure";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    Object.assign(this, extra);
  }
}

// Turns a non-OK HTTP response (status + parsed JSON body or null) into an UploadFailure.
export function failureFromResponse(status, body) {
  if (body && typeof body.error === "string") {
    const { error, code = "SERVER_ERROR", ...extra } = body;
    const retryable =
      RETRYABLE_CODES.has(code) || (code === "SERVER_ERROR" && status >= 500);
    return new UploadFailure(error, { code, status, retryable, ...extra });
  }
  // No JSON: the request never reached our server code (Nginx, Cloudflare, or the stream
  // server is down).
  if ([502, 503, 504, 520, 521, 522, 523, 524].includes(status)) {
    return new UploadFailure(
      `The server didn't answer (HTTP ${status}). The stream server or tunnel may be restarting.`,
      { code: "BAD_GATEWAY", status, retryable: true }
    );
  }
  if (status === 413) {
    return new UploadFailure(
      "A proxy rejected the chunk as too large (HTTP 413). Check client_max_body_size for /api/upload in nginx.conf.",
      { code: "PROXY_TOO_LARGE", status }
    );
  }
  if (status === 404) {
    return new UploadFailure(
      "The upload API wasn't found (HTTP 404). The server may be running an older version: restart the stream server and reload Nginx.",
      { code: "API_MISSING", status }
    );
  }
  return new UploadFailure(`Unexpected response from the server (HTTP ${status}).`, {
    code: "UNEXPECTED_RESPONSE",
    status,
    retryable: status >= 500
  });
}

function isAbort(err, signal) {
  return err?.name === "AbortError" || signal?.aborted;
}

function canceled() {
  return new UploadFailure("Upload canceled.", { code: "CANCELED" });
}

const defaultSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(canceled());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(canceled());
      },
      { once: true }
    );
  });

export function createUploadClient({
  getKey,
  fetchImpl = (...args) => fetch(...args),
  base = "/api/upload",
  sleep = defaultSleep,
  retryDelays = RETRY_DELAYS_MS
} = {}) {
  // One HTTP request → parsed JSON, or throws UploadFailure.
  async function request(method, path, { json, body, signal, headers = {} } = {}) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          "X-Upload-Key": getKey() || "",
          ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers
        },
        body: json !== undefined ? JSON.stringify(json) : body,
        signal,
        cache: "no-store"
      });
    } catch (err) {
      if (isAbort(err, signal)) throw canceled();
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      throw new UploadFailure(
        offline
          ? "You're offline. The upload will continue when you retry."
          : "Couldn't reach the server (network error, or the site's address changed).",
        { code: "NETWORK", retryable: true }
      );
    }
    let parsed = null;
    try {
      const text = await res.text();
      parsed = text ? JSON.parse(text) : null;
    } catch (err) {
      if (isAbort(err, signal)) throw canceled();
      parsed = null;
    }
    if (!res.ok) throw failureFromResponse(res.status, parsed);
    if (parsed === null || typeof parsed !== "object") {
      throw new UploadFailure("The server sent an unreadable reply.", {
        code: "UNEXPECTED_RESPONSE",
        status: res.status,
        retryable: true
      });
    }
    return parsed;
  }

  // request() with automatic retries for transient failures.
  async function withRetry(fn, { signal, onRetry } = {}) {
    let busyWaits = 0;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        const failure = err instanceof UploadFailure ? err : new UploadFailure(err.message || String(err), { code: "CLIENT_ERROR" });
        // Still busy with an earlier request (e.g. a "complete" whose reply was lost and is
        // still checking the video): wait without using up retries.
        if (failure.code === "BUSY" && busyWaits < MAX_BUSY_WAITS && !signal?.aborted) {
          busyWaits += 1;
          attempt -= 1;
          onRetry?.(new UploadFailure("The server is still busy with this file; waiting…", { code: "BUSY" }), busyWaits);
          await sleep(BUSY_WAIT_MS, signal);
          continue;
        }
        if (!failure.retryable || attempt >= MAX_ATTEMPTS || signal?.aborted) throw failure;
        onRetry?.(failure, attempt);
        await sleep(retryDelays[Math.min(attempt - 1, retryDelays.length - 1)], signal);
      }
    }
  }

  const sessionPath = (id) => `/session/${encodeURIComponent(id)}`;

  return {
    checkAuth: () => request("GET", "/auth"),
    listFolders: () => request("GET", "/folders"),
    createFolder: (path) => request("POST", "/folders", { json: { path } }),
    catalogStatus: () => request("GET", "/status"),
    cancel: (id) => request("DELETE", sessionPath(id)),

    // Uploads one File into `folder` ("Course/Section", "" = root) under `name` (default:
    // file.name). Resumes a matching unfinished upload on the server. Calls
    // onProgress({ loaded, total }) and onRetry(failure, attempt). Resolves to the server's
    // result ({ path, url, kind, warning }); rejects with UploadFailure (err.sessionId is set
    // once the server has a session, for cancel/rename).
    // previousSessionId: the session of an earlier failed attempt; if the server already
    // finished it (the reply got lost), its result is returned instead of uploading again.
    async uploadFile(file, folder, { name = file.name, signal, onProgress, onRetry, onSession, previousSessionId, chunkBytes = DEFAULT_CHUNK_BYTES } = {}) {
      const total = file.size;
      if (previousSessionId) {
        try {
          const info = await request("GET", sessionPath(previousSessionId), { signal });
          if (info.done && info.result) {
            onProgress?.({ loaded: total, total });
            return info.result;
          }
        } catch (err) {
          if (err.code === "CANCELED") throw err;
          // Gone or unreachable: fall through to a normal (resuming) upload.
        }
      }
      const session = await withRetry(
        () => request("POST", "", { json: { folder, name, size: total, lastModified: file.lastModified }, signal }),
        { signal, onRetry }
      );
      onSession?.(session);
      const id = session.id;
      const chunk = Math.max(1, Math.min(chunkBytes, session.chunkBytes || chunkBytes));
      let offset = session.offset || 0;
      onProgress?.({ loaded: offset, total });

      try {
        let resyncs = 0;
        let attempt = 0;
        let busyWaits = 0;
        while (offset < total) {
          const end = Math.min(offset + chunk, total);
          try {
            const result = await request("PUT", `${sessionPath(id)}?offset=${offset}`, {
              body: file.slice(offset, end),
              headers: { "Content-Type": "application/octet-stream" },
              signal
            });
            offset = result.offset;
            attempt = 0;
            onProgress?.({ loaded: offset, total });
          } catch (err) {
            if (err.code === "CANCELED") throw err;
            // An earlier attempt already finished it (its reply was lost).
            if (err.code === "ALREADY_COMPLETE" && err.result) return err.result;
            if (err.code === "BUSY" && busyWaits < MAX_BUSY_WAITS) {
              busyWaits += 1;
              onRetry?.(new UploadFailure("Waiting for the server to release an interrupted chunk…", { code: "BUSY" }), busyWaits);
              await sleep(BUSY_WAIT_MS, signal);
              continue;
            }
            if (err.code === "OFFSET_MISMATCH" && Number.isSafeInteger(err.offset)) {
              if (++resyncs > MAX_OFFSET_RESYNCS) throw err;
              offset = err.offset;
              onProgress?.({ loaded: offset, total });
              continue;
            }
            attempt += 1;
            if (!err.retryable || attempt >= MAX_ATTEMPTS) throw err;
            onRetry?.(err, attempt);
            await sleep(retryDelays[Math.min(attempt - 1, retryDelays.length - 1)], signal);
            // The chunk may have landed before the connection dropped: ask where to continue.
            try {
              const info = await request("GET", sessionPath(id), { signal });
              if (info.done && info.result) return info.result;
              offset = info.offset;
              onProgress?.({ loaded: offset, total });
            } catch (infoErr) {
              if (infoErr.code === "CANCELED" || !infoErr.retryable) throw infoErr;
              // Couldn't ask; the PUT's OFFSET_MISMATCH will tell us next round.
            }
          }
        }
        return await withRetry(
          () => request("POST", `${sessionPath(id)}/complete`, { json: { name }, signal }),
          { signal, onRetry }
        );
      } catch (err) {
        err.sessionId = id;
        throw err;
      }
    },

    // Finishes an already fully uploaded session under a new name (after NAME_TAKEN).
    finishAs: (id, name) => request("POST", `${sessionPath(id)}/complete`, { json: { name } })
  };
}

// Checks a file before uploading: same rules as the server, to fail fast with a clear message.
// Returns an error string or "".
export const ACCEPTED_EXTENSIONS = [".mp4", ".m4v", ".mov", ".webm", ".vtt", ".srt", ".jpg", ".jpeg", ".png", ".webp"];

export function precheckFile(file, { maxFileBytes } = {}) {
  const name = file?.name || "";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
  if (name.startsWith(".")) return "Hidden files (starting with a dot) aren't shown in the library.";
  if (!ACCEPTED_EXTENSIONS.includes(ext)) {
    return `"${ext || name}" files aren't supported. Allowed: ${ACCEPTED_EXTENSIONS.join(", ")}.`;
  }
  if (!(file.size > 0)) return "The file is empty.";
  if (maxFileBytes && file.size > maxFileBytes) return "The file is larger than the server's upload limit.";
  return "";
}

// Average rate over a sliding window of { t, loaded } samples → bytes per second (0 if unknown).
export function bytesPerSecond(samples) {
  if (!samples || samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = (last.t - first.t) / 1000;
  return dt > 0 ? Math.max(0, (last.loaded - first.loaded) / dt) : 0;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
