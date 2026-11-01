import React from "react";

export default function Navbar({
  searchQuery,
  onSearchChange,
  isTheaterMode,
  onToggleTheater,
  isSidePlayer,
  onToggleSidePlayer,
  theme = "light",
  onToggleTheme,
  onToggleMenu,
  currentPage = "home",
  onNavigate
}) {
  const isLight = theme === "light";

  return (
    <header className="navbar">
      <div className="navbar-left">
        <button
          type="button"
          className="hamburger-btn"
          onClick={onToggleMenu}
          title="Open navigation menu"
          aria-label="Open navigation menu"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>

        <div
          className="brand clickable-brand"
          onClick={() => onNavigate?.("home")}
          role="button"
          tabIndex={0}
          title="Go to TylerTube Home"
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") onNavigate?.("home");
          }}
        >
          <span className="brand-icon" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="6 4 20 12 6 20 6 4" />
            </svg>
          </span>
          <h1>TylerTube</h1>
        </div>

        {currentPage !== "home" && (
          <div className="nav-page-indicator">
            <span className="nav-page-divider">/</span>
            <span className="nav-page-name">
              {currentPage === "history" ? "History" : "Favorites"}
            </span>
          </div>
        )}
      </div>

      <div className="header-actions">
        <input
          type="search"
          id="searchInput"
          placeholder="Search library..."
          aria-label="Search library"
          value={searchQuery}
          onChange={(e) => {
            onSearchChange(e.target.value);
            if (currentPage !== "home") {
              onNavigate?.("home");
            }
          }}
        />
        <button
          type="button"
          className={`btn-secondary ${isSidePlayer ? "active" : ""}`}
          onClick={onToggleSidePlayer}
          title="Toggle Floating Side Player (S)"
        >
          ⧉ Side Player
        </button>
        {currentPage === "home" && (
          <button
            type="button"
            className={`btn-secondary ${isTheaterMode ? "active" : ""}`}
            onClick={onToggleTheater}
            title="Toggle Theater Mode (T)"
          >
            Theater Mode
          </button>
        )}
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
