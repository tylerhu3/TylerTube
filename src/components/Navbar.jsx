import React from "react";

export default function Navbar({
  searchQuery,
  onSearchChange,
  isTheaterMode,
  onToggleTheater,
  theme = "light",
  onToggleTheme
}) {
  const isLight = theme === "light";

  return (
    <header className="navbar">
      <div className="brand">
        <span className="brand-icon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="6 4 20 12 6 20 6 4" />
          </svg>
        </span>
        <h1>TylerTube</h1>
      </div>
      <div className="header-actions">
        <input
          type="search"
          id="searchInput"
          placeholder="Search library..."
          aria-label="Search library"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        <button
          type="button"
          className={`btn-secondary ${isTheaterMode ? "active" : ""}`}
          onClick={onToggleTheater}
          title="Toggle Theater Mode (T)"
        >
          Theater Mode
        </button>
        <button
          type="button"
          className="btn-secondary theme-toggle-btn"
          onClick={onToggleTheme}
          title={isLight ? "Switch to Dark Mode" : "Switch to Light Mode"}
          aria-label={isLight ? "Switch to Dark Mode" : "Switch to Light Mode"}
        >
          {isLight ? "🌙 Dark" : "☀️ Light"}
        </button>
      </div>
    </header>
  );
}

