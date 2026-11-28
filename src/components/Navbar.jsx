import React, { useState, useRef, useEffect } from "react";
import { COLOR_THEMES } from "../data/themeColors";
import { getGoogleLoginUrl } from "../lib/auth";

const PAGE_LABELS = { home: "Library", history: "History", favorites: "Favorites", upload: "Upload", youtube: "YouTube", shorts: "Shorts" };

export default function Navbar({
  searchQuery,
  onSearchChange,
  isTheaterMode,
  onToggleTheater,
  isSidePlayer,
  onToggleSidePlayer,
  viewMode = "desktop",
  theme = "light",
  onToggleTheme,
  colorTheme = "pink",
  onColorThemeChange,
  onToggleMenu,
  currentPage = "youtube",
  onNavigate,
  auth = null,
  onLogout
}) {
  const isLight = theme === "light";
  const isMobileMode = viewMode === "mobile";
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const mobileSearchInputRef = useRef(null);
  const colorPickerRef = useRef(null);
  const userMenuRef = useRef(null);

  const activeColorMeta =
    COLOR_THEMES.find((c) => c.id === colorTheme) || COLOR_THEMES[0];

  useEffect(() => {
    if (!isUserMenuOpen) return;
    const handleClickOutside = (e) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setIsUserMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isUserMenuOpen]);

  useEffect(() => {
    if (!isColorPickerOpen) return;
    const handleClickOutside = (e) => {
      if (
        colorPickerRef.current &&
        !colorPickerRef.current.contains(e.target)
      ) {
        setIsColorPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isColorPickerOpen]);

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
            onClick={() => onNavigate?.("youtube")}
            role="button"
            tabIndex={0}
            title="Go to TylerTube YouTube"
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onNavigate?.("youtube");
            }}
          >
            <span className="brand-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="6 4 20 12 6 20 6 4" />
              </svg>
            </span>
            <h1>TylerTube</h1>
          </div>

          {currentPage !== "youtube" && (
            <div className="nav-page-indicator">
              <span className="nav-page-divider">/</span>
              <span className="nav-page-name">
                {PAGE_LABELS[currentPage] || currentPage}
              </span>
            </div>
          )}
        </div>

        <div className="header-actions">
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
              ⧉<span className="nav-btn-label">Side Player</span>
              <span className="nav-btn-label-short">Side</span>
            </button>
          )}

          {!isMobileMode && currentPage === "home" && (
            <button
              type="button"
              className={`btn-secondary ${isTheaterMode ? "active" : ""}`}
              onClick={onToggleTheater}
              title="Toggle Theater Mode (T)"
            >
              <span className="nav-btn-label">Theater Mode</span>
              <span className="nav-btn-label-short">Theater</span>
            </button>
          )}

          {/* Color Theme Picker Dropdown */}
          <div className="color-theme-dropdown-wrap" ref={colorPickerRef}>
            <button
              type="button"
              className="btn-secondary color-theme-btn"
              onClick={() => setIsColorPickerOpen((prev) => !prev)}
              title="Change Accent Color Theme"
              aria-label="Change Accent Color Theme"
              aria-expanded={isColorPickerOpen}
            >
              <span
                className="color-theme-btn-swatch"
                style={{
                  backgroundColor:
                    theme === "dark"
                      ? activeColorMeta.darkColor
                      : activeColorMeta.color,
                }}
              />
              {!isMobileMode && (
                <span className="color-theme-btn-label">Color</span>
              )}
            </button>

            {isColorPickerOpen && (
              <div className="color-theme-dropdown" role="menu">
                <div className="color-theme-dropdown-title">Theme Color</div>
                <div className="color-theme-palette-grid">
                  {COLOR_THEMES.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`color-palette-btn ${
                        colorTheme === c.id ? "active" : ""
                      }`}
                      onClick={() => {
                        onColorThemeChange?.(c.id);
                        setIsColorPickerOpen(false);
                      }}
                      title={`Switch to ${c.name} accent`}
                      aria-label={`Switch to ${c.name} accent`}
                    >
                      <span
                        className="color-swatch-circle"
                        style={{
                          backgroundColor:
                            theme === "dark" ? c.darkColor : c.color,
                        }}
                      />
                      <span className="color-swatch-name">{c.name}</span>
                      {colorTheme === c.id && (
                        <span className="color-check-icon">✓</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            className="btn-secondary theme-toggle-btn"
            onClick={onToggleTheme}
            title={isLight ? "Switch to Dark Mode" : "Switch to Light Mode"}
            aria-label={isLight ? "Switch to Dark Mode" : "Switch to Light Mode"}
          >
            {isLight ? "🌙" : "☀️"}
            {!isMobileMode && (
              <span className="nav-btn-label theme-toggle-label">
                {isLight ? "Dark" : "Light"}
              </span>
            )}
          </button>

          {/* User Account / Google Login Button */}
          {auth?.authenticated && auth?.user ? (
            <div className="nav-user-wrap" ref={userMenuRef}>
              <button
                type="button"
                className="nav-user-btn"
                onClick={() => setIsUserMenuOpen((prev) => !prev)}
                title={`Signed in as ${auth.user.name}`}
                aria-expanded={isUserMenuOpen}
              >
                {auth.user.picture ? (
                  <img
                    src={auth.user.picture}
                    alt={auth.user.name}
                    className="nav-user-avatar"
                  />
                ) : (
                  <div className="nav-user-avatar">
                    {auth.user.name?.[0]?.toUpperCase() || "U"}
                  </div>
                )}
                {!isMobileMode && (
                  <span className="nav-btn-label">{auth.user.name.split(" ")[0]}</span>
                )}
              </button>

              {isUserMenuOpen && (
                <div className="nav-user-menu" role="menu">
                  <div className="nav-user-menu-header">
                    <div className="nav-user-menu-name">{auth.user.name}</div>
                    {auth.user.email && (
                      <div className="nav-user-menu-email">{auth.user.email}</div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="nav-user-menu-item"
                    onClick={() => {
                      setIsUserMenuOpen(false);
                      onLogout?.();
                    }}
                  >
                    🚪 Sign Out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <a
              href={getGoogleLoginUrl(currentPage)}
              className="btn-secondary nav-login-btn"
              title="Sign in with Google to view your subscriptions feed"
              style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
              </svg>
              {!isMobileMode && <span className="nav-btn-label">Sign in</span>}
            </a>
          )}
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
