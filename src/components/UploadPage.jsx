import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FolderPicker from "./upload/FolderPicker";
import UploadQueue from "./upload/UploadQueue";
import { readString, removeKey, writeString } from "../lib/storage";
import { setUploadQueueActive } from "../lib/uploadActivity";
import {
  ACCEPTED_EXTENSIONS,
  bytesPerSecond,
  createUploadClient,
  formatBytes,
  precheckFile
} from "../lib/uploader";

const STATUS_POLL_MS = 15000;
const RATE_WINDOW_MS = 10000;
// Failures where retrying the same file the same way can't help.
const FINAL_CODES = new Set([
  "PRECHECK",
  "NOT_A_VIDEO",
  "UNSUPPORTED_TYPE",
  "INVALID_NAME",
  "INVALID_SIZE",
  "FILE_TOO_LARGE",
  "NAME_TAKEN",
  "CANCELED"
]);
const AUTH_CODES = new Set(["BAD_KEY", "UPLOADS_DISABLED", "TOO_MANY_ATTEMPTS"]);

let nextKey = 1;

// keyStorageKey: localStorage key for the upload key (defined in App.jsx; not synced).
export default function UploadPage({ keyStorageKey, onNavigateHome }) {
  const [uploadKey, setUploadKey] = useState(() => readString(keyStorageKey, ""));
  const [keyDraft, setKeyDraft] = useState("");
  const [auth, setAuth] = useState({ state: uploadKey ? "checking" : "locked", info: null, error: "" });
  const [folders, setFolders] = useState([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [foldersError, setFoldersError] = useState("");
  const [selectedFolder, setSelectedFolder] = useState("");
  const [items, setItems] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState("");

  const keyRef = useRef(uploadKey);
  keyRef.current = uploadKey;
  const client = useMemo(() => createUploadClient({ getKey: () => keyRef.current }), []);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const activeRef = useRef(null); // { key, controller }
  const samplesRef = useRef(new Map()); // item key → [{ t, loaded }]
  const fileInputRef = useRef(null);

  const updateItem = useCallback((key, patch) => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...(typeof patch === "function" ? patch(it) : patch) } : it)));
  }, []);

  // Deletes a partial upload on the server. While the server still holds it (a chunk from the
  // aborted request is finishing) it answers BUSY, so keep trying for about a minute. Resolves
  // to "" or an error message. Unfinished uploads are cleaned up after 24 h regardless.
  const discardOnServer = useCallback(
    async (sessionId) => {
      for (let i = 0; i < 15; i += 1) {
        try {
          await client.cancel(sessionId);
          return "";
        } catch (err) {
          if (err.code === "SESSION_NOT_FOUND") return "";
          if (err.code !== "BUSY" && !err.retryable) return err.message;
          await new Promise((r) => setTimeout(r, 4000));
        }
      }
      return "The server kept the partial upload busy; it will be deleted automatically within 24 h.";
    },
    [client]
  );

  const lockWith = useCallback((message) => {
    setAuth({ state: "locked", info: null, error: message });
  }, []);

  // --- Auth -----------------------------------------------------------------------------
  const loadFolders = useCallback(async () => {
    setFoldersLoading(true);
    setFoldersError("");
    try {
      const { folders: list } = await client.listFolders();
      setFolders(Array.isArray(list) ? list : []);
    } catch (err) {
      if (AUTH_CODES.has(err.code)) lockWith(err.message);
      setFoldersError(`Couldn't load folders: ${err.message}`);
    } finally {
      setFoldersLoading(false);
    }
  }, [client, lockWith]);

  const checkKey = useCallback(async () => {
    setAuth((prev) => ({ ...prev, state: "checking", error: "" }));
    try {
      const info = await client.checkAuth();
      writeString(keyStorageKey, keyRef.current); // saved only once the server accepts it
      setAuth({ state: "ok", info, error: "" });
      loadFolders();
    } catch (err) {
      setAuth({ state: AUTH_CODES.has(err.code) ? "locked" : "error", info: null, error: err.message });
    }
  }, [client, loadFolders, keyStorageKey]);

  useEffect(() => {
    if (uploadKey) checkKey();
    // Only on mount; later checks are explicit.
  }, []);

  const handleUnlock = (e) => {
    e.preventDefault();
    const key = keyDraft.trim();
    if (!key) return;
    keyRef.current = key;
    setUploadKey(key);
    setKeyDraft("");
    checkKey();
  };

  const handleForgetKey = () => {
    if (activeRef.current) return;
    removeKey(keyStorageKey);
    keyRef.current = "";
    setUploadKey("");
    setAuth({ state: "locked", info: null, error: "" });
  };

  // --- Folders ----------------------------------------------------------------------------
  const handleCreateFolder = useCallback(
    async (path) => {
      try {
        const result = await client.createFolder(path);
        await loadFolders();
        setSelectedFolder(result.path);
        setNotice(result.created ? `Created "${result.path}".` : `"${result.path}" already exists; selected it.`);
      } catch (err) {
        if (AUTH_CODES.has(err.code)) lockWith(err.message);
        throw err;
      }
    },
    [client, loadFolders, lockWith]
  );

  // --- Queue ------------------------------------------------------------------------------
  const addFiles = useCallback(
    (fileList) => {
      const files = Array.from(fileList || []);
      if (files.length === 0) return;
      const maxFileBytes = auth.info?.maxFileBytes;
      const existing = itemsRef.current;
      const added = [];
      let skipped = 0;
      for (const file of files) {
        const duplicate = existing.concat(added).some(
          (it) =>
            it.file.name === file.name &&
            it.file.size === file.size &&
            it.folder === selectedFolder &&
            ["queued", "uploading", "finishing"].includes(it.status)
        );
        if (duplicate) {
          skipped += 1;
          continue;
        }
        const problem = precheckFile(file, { maxFileBytes });
        added.push({
          key: nextKey++,
          file,
          name: file.name,
          folder: selectedFolder,
          status: problem ? "error" : "queued",
          loaded: 0,
          total: file.size,
          rate: 0,
          error: problem ? { message: problem, code: "PRECHECK" } : null,
          canRetry: false,
          kind: /\.(mp4|m4v|mov|webm)$/i.test(file.name) ? "video" : "other",
          live: false
        });
      }
      setItems((prev) => [...prev, ...added]);
      setNotice(skipped ? `Skipped ${skipped} file(s) already in the queue for this folder.` : "");
    },
    [auth.info, selectedFolder]
  );

  const runUpload = useCallback(
    async (item) => {
      const controller = new AbortController();
      activeRef.current = { key: item.key, controller };
      samplesRef.current.set(item.key, []);
      updateItem(item.key, { status: "uploading", error: null, retryNote: "", rate: 0 });

      try {
        const result = await client.uploadFile(item.file, item.folder, {
          name: item.name,
          previousSessionId: item.sessionId || undefined,
          signal: controller.signal,
          onSession: (session) => {
            updateItem(item.key, {
              sessionId: session.id,
              retryNote: session.resumed && session.offset > 0 ? `Resumed at ${formatBytes(session.offset)}.` : ""
            });
          },
          onProgress: ({ loaded, total }) => {
            const now = Date.now();
            const samples = (samplesRef.current.get(item.key) || []).concat({ t: now, loaded });
            while (samples.length > 2 && now - samples[0].t > RATE_WINDOW_MS) samples.shift();
            samplesRef.current.set(item.key, samples);
            updateItem(item.key, {
              loaded,
              total,
              rate: bytesPerSecond(samples),
              status: loaded >= total ? "finishing" : "uploading"
            });
          },
          onRetry: (failure, attempt) => {
            updateItem(item.key, { retryNote: `${failure.message} Retrying (attempt ${attempt + 1})…` });
          }
        });
        updateItem(item.key, {
          status: "done",
          loaded: item.file.size,
          sessionId: null,
          warning: result.warning || "",
          retryNote: "",
          kind: result.kind,
          finishedAt: Date.now()
        });
      } catch (err) {
        if (err.code === "CANCELED") {
          updateItem(item.key, { status: "canceled", retryNote: "", sessionId: null });
          if (err.sessionId) {
            discardOnServer(err.sessionId).then((problem) => {
              if (problem) updateItem(item.key, { error: { message: `Couldn't delete the partial upload: ${problem}`, code: "DISCARD_FAILED" } });
            });
          }
        } else {
          if (AUTH_CODES.has(err.code)) lockWith(err.message);
          if (err.code === "FOLDER_NOT_FOUND") loadFolders();
          updateItem(item.key, {
            status: "error",
            retryNote: "",
            // NOT_A_VIDEO deletes the session on the server.
            sessionId: err.code === "NOT_A_VIDEO" ? null : err.sessionId || null,
            error: { message: err.message, code: err.code, suggestion: err.suggestion || "" },
            canRetry: !FINAL_CODES.has(err.code)
          });
        }
      } finally {
        samplesRef.current.delete(item.key);
        activeRef.current = null;
        // Kick the runner (the state update above re-renders, but be explicit).
        setItems((prev) => [...prev]);
      }
    },
    [client, updateItem, lockWith, loadFolders, discardOnServer]
  );

  // One upload at a time, in queue order.
  useEffect(() => {
    if (activeRef.current || auth.state !== "ok") return;
    const next = items.find((it) => it.status === "queued");
    if (next) runUpload(next);
  }, [items, auth.state, runUpload]);

  const handleCancel = useCallback(
    (key) => {
      if (activeRef.current?.key === key) {
        activeRef.current.controller.abort();
        return;
      }
      const item = itemsRef.current.find((it) => it.key === key);
      updateItem(key, { status: "canceled", sessionId: null });
      if (item?.sessionId) discardOnServer(item.sessionId);
    },
    [updateItem, discardOnServer]
  );

  const handleRetry = useCallback((key) => {
    updateItem(key, { status: "queued", error: null });
  }, [updateItem]);

  const handleUseName = useCallback(
    async (key) => {
      const item = itemsRef.current.find((it) => it.key === key);
      const suggestion = item?.error?.suggestion;
      if (!suggestion) return;
      if (!item.sessionId) {
        // The name clash was found before uploading: start again under the new name.
        updateItem(key, { name: suggestion, status: "queued", error: null });
        return;
      }
      // Fully uploaded already: just finish it under the new name.
      updateItem(key, { name: suggestion, status: "finishing", error: null });
      try {
        const result = await client.finishAs(item.sessionId, suggestion);
        updateItem(key, { status: "done", sessionId: null, warning: result.warning || "", kind: result.kind, finishedAt: Date.now() });
      } catch (err) {
        updateItem(key, {
          status: "error",
          error: { message: err.message, code: err.code, suggestion: err.suggestion || "" },
          canRetry: !FINAL_CODES.has(err.code)
        });
      }
    },
    [client, updateItem]
  );

  const handleRemove = useCallback(
    async (key) => {
      const item = itemsRef.current.find((it) => it.key === key);
      if (item?.sessionId && item.status !== "done") {
        updateItem(key, { retryNote: "Deleting the partial upload…" });
        const problem = await discardOnServer(item.sessionId);
        if (problem) {
          updateItem(key, { retryNote: "", error: { message: `Couldn't delete the partial upload: ${problem}`, code: "DISCARD_FAILED" } });
          return;
        }
      }
      setItems((prev) => prev.filter((it) => it.key !== key));
    },
    [updateItem, discardOnServer]
  );

  // Clears done/canceled items; failed ones that still have a partial upload stay (Discard).
  const handleClearFinished = useCallback(() => {
    setItems((prev) => prev.filter((it) => !(it.status === "done" || it.status === "canceled" || (it.status === "error" && !it.sessionId))));
  }, []);

  useEffect(() => {
    setUploadQueueActive(items.length > 0);
  }, [items.length]);
  useEffect(() => () => setUploadQueueActive(false), []);

  // Warn before leaving while anything is in flight.
  const busy = items.some((it) => ["queued", "uploading", "finishing"].includes(it.status));
  useEffect(() => {
    if (!busy) return;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [busy]);

  // After a video lands, poll until the rebuilt catalog is live.
  const waitingForCatalog = items.some((it) => it.status === "done" && it.kind === "video" && !it.live);
  useEffect(() => {
    if (!waitingForCatalog || auth.state !== "ok") return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const status = await client.catalogStatus();
        if (stopped || status.pendingRebuild || status.autoRebuild === false) return;
        setItems((prev) =>
          prev.map((it) =>
            it.status === "done" && it.kind === "video" && Date.now() - (it.finishedAt || 0) >= STATUS_POLL_MS
              ? { ...it, live: true }
              : it
          )
        );
      } catch {
        // Polling is best effort.
      }
    }, STATUS_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [waitingForCatalog, auth.state, client]);

  // --- Render -----------------------------------------------------------------------------
  const header = (
    <div className="subpage-header">
      <div className="subpage-title-row">
        <h2>Upload</h2>
      </div>
      <p className="subpage-subtitle">
        Add videos, subtitles (.vtt/.srt) and posters to the library. Large files are sent in
        pieces and resume after a dropped connection.
      </p>
    </div>
  );

  if (auth.state !== "ok") {
    return (
      <div className="subpage-container upload-page">
        {header}
        <div className="empty-state-card upload-lock-card">
          <div className="empty-state-icon" aria-hidden="true">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="11" width="16" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
          </div>
          {auth.state === "checking" ? (
            <h3>Checking upload key…</h3>
          ) : (
            <>
              <h3>{auth.state === "error" ? "Can't reach the upload service" : "Enter the upload key"}</h3>
              <p>
                {auth.state === "error"
                  ? readString(keyStorageKey, "")
                    ? "Your key is saved on this device; check the server and try again."
                    : "Your key isn't saved yet (it's saved once the server accepts it). Check the server and try again."
                  : "Uploading needs the key configured on the server (TYLERTUBE_UPLOAD_KEY or data/upload-key). It's stored on this device only."}
              </p>
              {auth.error && <div className="upload-error" role="alert">{auth.error}</div>}
              {auth.state === "error" ? (
                <div className="upload-lock-actions">
                  <button type="button" className="btn-primary-action" onClick={checkKey}>Try again</button>
                  <button type="button" className="upload-link-btn" onClick={handleForgetKey}>Use a different key</button>
                </div>
              ) : (
                <form className="upload-key-form" onSubmit={handleUnlock}>
                  <input
                    type="password"
                    value={keyDraft}
                    autoComplete="off"
                    placeholder="Upload key"
                    aria-label="Upload key"
                    onChange={(e) => setKeyDraft(e.target.value)}
                  />
                  <button type="submit" className="btn-primary-action" disabled={!keyDraft.trim()}>
                    Unlock
                  </button>
                </form>
              )}
            </>
          )}
          <button type="button" className="upload-link-btn" onClick={onNavigateHome}>Back to library</button>
        </div>
      </div>
    );
  }

  const info = auth.info || {};
  const lowSpace = info.freeBytes != null && info.reserveBytes != null && info.freeBytes - info.reserveBytes < 2 * 1024 ** 3;

  return (
    <div className="subpage-container upload-page">
      {header}
      <div className="upload-layout">
        <FolderPicker
          folders={folders}
          selected={selectedFolder}
          onSelect={setSelectedFolder}
          onCreate={handleCreateFolder}
          onRefresh={loadFolders}
          loading={foldersLoading}
          error={foldersError}
          maxDepth={info.maxFolderDepth || 3}
        />

        <div className="upload-main-col">
          <section
            className={`upload-panel upload-dropzone ${dragOver ? "drag-over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              addFiles(e.dataTransfer?.files);
            }}
          >
            <div className="upload-dropzone-icon" aria-hidden="true">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>
            <p className="upload-dropzone-text">
              Drop files here, or
            </p>
            <button type="button" className="btn-primary-action" onClick={() => fileInputRef.current?.click()}>
              Choose files
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              accept={ACCEPTED_EXTENSIONS.join(",")}
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <p className="upload-dropzone-dest">
              Uploading to <strong>{selectedFolder || "library root"}</strong>
            </p>
            <p className="upload-hint">
              {info.freeBytes != null && `${formatBytes(info.freeBytes)} free on the server`}
              {info.maxFileBytes != null && ` · max ${formatBytes(info.maxFileBytes)} per file`}
              {" · "}
              <button type="button" className="upload-link-btn inline" onClick={handleForgetKey} disabled={busy}>
                Forget key
              </button>
            </p>
            {lowSpace && (
              <div className="upload-warning">
                The server is low on disk space; large uploads may be refused.
              </div>
            )}
          </section>

          {notice && <div className="upload-notice">{notice}</div>}

          <UploadQueue
            items={items}
            onCancel={handleCancel}
            onRetry={handleRetry}
            onUseName={handleUseName}
            onRemove={handleRemove}
            onClearFinished={handleClearFinished}
            onReload={() => window.location.reload()}
          />
        </div>
      </div>
    </div>
  );
}
