import React, { useEffect, useRef, useState } from "react";

// Folder tree of public/videos/ (folders only) with "new folder" inside the selected one.
// The top level is a course, deeper levels are sections (see server/catalog.js).
export default function FolderPicker({
  folders = [],
  selected = "",
  onSelect,
  onCreate,
  onRefresh,
  loading = false,
  error = "",
  maxDepth = 3
}) {
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const listRef = useRef(null);

  // Keep the selected folder visible (e.g. right after creating one far down the list).
  useEffect(() => {
    listRef.current?.querySelector(".upload-folder-item.active")?.scrollIntoView({ block: "nearest" });
  }, [selected, folders]);

  const selectedDepth = selected ? selected.split("/").length : 0;
  const canNest = selectedDepth < maxDepth;

  const handleCreate = async (e) => {
    e.preventDefault();
    const name = draft.trim();
    if (!name) return;
    if (/[/\\:]/.test(name) || name.startsWith(".")) {
      setCreateError("Folder names can't contain / \\ : or start with a dot.");
      return;
    }
    setCreating(true);
    setCreateError("");
    try {
      await onCreate(selected ? `${selected}/${name}` : name);
      setDraft("");
    } catch (err) {
      setCreateError(err.message || String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="upload-panel upload-folders" aria-label="Destination folder">
      <div className="upload-panel-head">
        <h3>Destination</h3>
        <button
          type="button"
          className="upload-link-btn"
          onClick={onRefresh}
          disabled={loading}
          title="Reload the folder list"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      <p className="upload-hint">
        Top-level folders are courses; folders inside them are sections.
      </p>

      {error && <div className="upload-error" role="alert">{error}</div>}

      <ul ref={listRef} className="upload-folder-list" role="listbox" aria-label="Folders">
        <li>
          <button
            type="button"
            role="option"
            aria-selected={selected === ""}
            className={`upload-folder-item ${selected === "" ? "active" : ""}`}
            onClick={() => onSelect("")}
          >
            <span className="upload-folder-icon" aria-hidden="true">⌂</span>
            Library root <span className="upload-folder-note">(shows as "General")</span>
          </button>
        </li>
        {folders.map((folder) => {
          const parts = folder.split("/");
          return (
            <li key={folder}>
              <button
                type="button"
                role="option"
                aria-selected={selected === folder}
                className={`upload-folder-item ${selected === folder ? "active" : ""}`}
                style={{ paddingLeft: `${0.75 + (parts.length - 1) * 1.1}rem` }}
                onClick={() => onSelect(folder)}
                title={folder}
              >
                <span className="upload-folder-icon" aria-hidden="true">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" />
                  </svg>
                </span>
                <span className="upload-folder-name">{parts[parts.length - 1]}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <form className="upload-new-folder" onSubmit={handleCreate}>
        <label htmlFor="upload-new-folder-input">
          New folder in <strong>{selected || "library root"}</strong>
        </label>
        <div className="upload-new-folder-row">
          <input
            id="upload-new-folder-input"
            type="text"
            value={draft}
            maxLength={120}
            placeholder={canNest ? (selected ? "Section name" : "Course name") : "Too deep"}
            disabled={!canNest || creating}
            onChange={(e) => {
              setDraft(e.target.value);
              setCreateError("");
            }}
          />
          <button type="submit" className="btn-primary-action" disabled={!canNest || creating || !draft.trim()}>
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
        {!canNest && (
          <div className="upload-hint">Folders can be at most {maxDepth} levels deep.</div>
        )}
        {createError && <div className="upload-error" role="alert">{createError}</div>}
      </form>
    </section>
  );
}
