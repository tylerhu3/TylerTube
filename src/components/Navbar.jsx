import React, { useState, useRef, useEffect } from "react";

export default function Navbar({
  searchQuery,
  onSearchChange,
  isTheaterMode,
  onToggleTheater,
  isSidePlayer,
  onToggleSidePlayer,
  viewMode = "desktop",
  onViewModeChange,
  theme = "light",
  onToggleTheme,
  onToggleMenu,
  currentPage = "home",
  onNavigate
}) {
  const isLight = theme === "light";
  const isMobileMode = viewMode === "mobile";
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const mobileSearchInputRef = useRef(null);

  useEffect(() => {
    if (mobileSearchOpen && mobileSearchInputRef.current) {
      mobileSearchInputRef.current.focus();
    }
  }, [mobileSearchOpen]);

  const handleSearchInput = (val) => {
    onSearchChange(val);
    if (val && currentPage !== "home") {
      onNavigate?.("home");
    }
  };

  return (
    <header className={`navbar ${isMobileMode ? "navbar-mobile" : "navbar-desktop"}`}>
      <div className="navbar-main-row">
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
          {/* Top Switcher: Mobile vs Desktop View */}
          <div
            className="view-mode-switcher"
            role="group"
            aria-label="Switch between Desktop and Mobile view"
          >
            <button
              type="button"
              className={`view-mode-btn ${!isMobileMode ? "active" : ""}`}
              onClick={() => onViewModeChange?.("desktop")}
              aria-pressed={!isMobileMode}
              title="Switch to Desktop View (M)"
            >
              <span className="view-mode-icon" aria-hidden="true">🖥</span>
              <span className="view-mode-label">Desktop</span>
            </button>
            <button
              type="button"
              className={`view-mode-btn ${isMobileMode ? "active" : ""}`}
              onClick={() => onViewModeChange?.("mobile")}
              aria-pressed={isMobileMode}
              title="Switch to Mobile View (M)"
            >
              <span className="view-mode-icon" aria-hidden="true">📱</span>
              <span className="view-mode-label">Mobile</span>
            </button>
          </div>

          {!isMobileMode ? (
            <div className="desktop-search-wrapper">
              <input
                type="search"
                id="searchInput"
                placeholder="Search library..."
                aria-label="Search library"
                value={searchQuery}
                onChange={(e) => handleSearchInput(e.target.value)}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="search-clear-btn"
                  onClick={() => onSearchChange("")}
                  title="Clear search"
                  aria-label="Clear search"
                >
                  ✕
                </button>
              )}
            </div>
          ) : (
            <button
              type="button"
              className={`btn-secondary mobile-icon-btn ${
                mobileSearchOpen || searchQuery ? "active" : ""
              }`}
              onClick={() => setMobileSearchOpen((prev) => !prev)}
              title="Search library"
              aria-label="Toggle search bar"
            >
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </button>
          )}

          {!isMobileMode && (
            <button
              type="button"
              className={`btn-secondary ${isSidePlayer ? "active" : ""}`}
              onClick={onToggleSidePlayer}
              title="Toggle Floating Side Player (S)"
            >
              ⧉ Side Player
            </button>
          )}

          {!isMobileMode && currentPage === "home" && (
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
            {isMobileMode ? (isLight ? "🌙" : "☀️") : isLight ? "🌙 Dark" : "☀️ Light"}
          </button>
        </div>
      </div>

      {/* Expandable Search Bar in Mobile Mode */}
      {isMobileMode && (mobileSearchOpen || searchQuery) && (
        <div className="mobile-search-bar">
          <div className="mobile-search-input-wrap">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mobile-search-icon"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              ref={mobileSearchInputRef}
              type="search"
              className="mobile-search-input"
              placeholder="Search videos, courses, or sections..."
              aria-label="Search library"
              value={searchQuery}
              onChange={(e) => handleSearchInput(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="mobile-search-clear"
                onClick={() => onSearchChange("")}
                aria-label="Clear search query"
              >
                ✕
              </button>
            )}
          </div>
          <button
            type="button"
            className="mobile-search-close"
            onClick={() => {
              setMobileSearchOpen(false);
            }}
          >
            Done
          </button>
        </div>
      )}
    </header>
  );
}
