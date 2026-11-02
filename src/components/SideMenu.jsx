import React, { useEffect } from "react";
import { COLOR_THEMES } from "../data/themeColors";

export default function SideMenu({
  isOpen,
  onClose,
  currentPage,
  onNavigate,
  viewMode = "desktop",
  onViewModeChange,
  colorTheme = "red",
  onColorThemeChange,
  totalVideosCount = 0,
  historyCount = 0,
  favoritesCount = 0,
  inProgressCount = 0,
  completedCount = 0
}) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const handleSelectPage = (page) => {
    onNavigate(page);
    onClose();
  };

  return (
    <>
      <div
        className={`side-menu-backdrop ${isOpen ? "open" : ""}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={`side-menu-drawer ${isOpen ? "open" : ""}`}
        aria-label="Main navigation"
        aria-hidden={!isOpen}
      >
        <div className="side-menu-header">
          <button
            type="button"
            className="hamburger-btn"
            onClick={onClose}
            title="Close menu"
            aria-label="Close navigation menu"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div
            className="brand clickable-brand"
            onClick={() => handleSelectPage("home")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") handleSelectPage("home");
            }}
          >
            <span className="brand-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="6 4 20 12 6 20 6 4" />
              </svg>
            </span>
            <h1>TylerTube</h1>
          </div>
        </div>

        <nav className="side-menu-nav">
          <div className="side-menu-section">
            <button
              type="button"
              className={`side-menu-item ${currentPage === "home" ? "active" : ""}`}
              onClick={() => handleSelectPage("home")}
            >
              <span className="side-menu-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1V9.5z" />
                </svg>
              </span>
              <span className="side-menu-label">Home</span>
              <span className="side-menu-badge">{totalVideosCount}</span>
            </button>

            <button
              type="button"
              className={`side-menu-item ${currentPage === "history" ? "active" : ""}`}
              onClick={() => handleSelectPage("history")}
            >
              <span className="side-menu-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                  <polyline points="3 3 3 8 8 8" />
                  <polyline points="12 7 12 12 15.5 14" />
                </svg>
              </span>
              <span className="side-menu-label">History</span>
              {historyCount > 0 && (
                <span className="side-menu-badge">{historyCount}</span>
              )}
            </button>

            <button
              type="button"
              className={`side-menu-item ${currentPage === "favorites" ? "active" : ""}`}
              onClick={() => handleSelectPage("favorites")}
            >
              <span className="side-menu-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill={currentPage === "favorites" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                </svg>
              </span>
              <span className="side-menu-label">Favorites</span>
              {favoritesCount > 0 && (
                <span className="side-menu-badge">{favoritesCount}</span>
              )}
            </button>
          </div>

          <div className="side-menu-divider" />

          <div className="side-menu-section">
            <div className="side-menu-section-title">Your Activity</div>
            <div className="side-menu-stats">
              <div className="side-menu-stat-row">
                <span>Continue Watching</span>
                <strong>{inProgressCount}</strong>
              </div>
              <div className="side-menu-stat-row">
                <span>Completed Videos</span>
                <strong>{completedCount}</strong>
              </div>
              <div className="side-menu-stat-row">
                <span>Saved Favorites</span>
                <strong>{favoritesCount}</strong>
              </div>
            </div>
          </div>

          <div className="side-menu-divider" />

          <div className="side-menu-section">
            <div className="side-menu-section-title">Accent Theme</div>
            <div className="side-menu-color-grid">
              {COLOR_THEMES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`side-menu-color-btn ${
                    colorTheme === c.id ? "active" : ""
                  }`}
                  onClick={() => onColorThemeChange?.(c.id)}
                  title={`Switch to ${c.name} accent`}
                  aria-label={`Switch to ${c.name} accent`}
                >
                  <span
                    className="side-menu-color-dot"
                    style={{ backgroundColor: c.color }}
                  />
                  <span className="side-menu-color-text">{c.name}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="side-menu-divider" />

          <div className="side-menu-section">
            <div className="side-menu-section-title">Display Layout</div>
            <div className="side-menu-view-toggle">
              <button
                type="button"
                className={`side-menu-view-btn ${viewMode === "desktop" ? "active" : ""}`}
                onClick={() => onViewModeChange?.("desktop")}
              >
                🖥 Desktop
              </button>
              <button
                type="button"
                className={`side-menu-view-btn ${viewMode === "mobile" ? "active" : ""}`}
                onClick={() => onViewModeChange?.("mobile")}
              >
                📱 Mobile
              </button>
            </div>
          </div>

          <div className="side-menu-divider" />

          <div className="side-menu-section side-menu-shortcuts">
            <div className="side-menu-section-title">Shortcuts</div>
            <div className="side-menu-shortcut-row">
              <span>Mobile / Desktop View</span>
              <kbd>M</kbd>
            </div>
            <div className="side-menu-shortcut-row">
              <span>Theater Mode</span>
              <kbd>T</kbd>
            </div>
            <div className="side-menu-shortcut-row">
              <span>Side Player</span>
              <kbd>S</kbd>
            </div>
          </div>
        </nav>
      </aside>
    </>
  );
}

