import React, { useEffect, useState } from "react";
import { COLOR_THEMES } from "../data/themeColors";
import { APP_VERSION, BUILD_TIME } from "../version";
import { formatLastSeen } from "../lib/visitors";
import { getGoogleLoginUrl } from "../lib/auth";

const VISITORS_PREVIEW = 5;

export default function SideMenu({
  isOpen,
  onClose,
  currentPage,
  onNavigate,
  viewMode = "desktop",
  onViewModeChange,
  theme = "light",
  colorTheme = "pink",
  onColorThemeChange,
  totalVideosCount = 0,
  historyCount = 0,
  favoritesCount = 0,
  inProgressCount = 0,
  completedCount = 0,
  visitors = null,
  selfVisitor = null,
  onVisitorNameChange,
  auth = null,
  onLogout
}) {
  const [showAllVisitors, setShowAllVisitors] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

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

        {/* User Account / Google Login in Side Drawer */}
        {auth?.authenticated && auth?.user ? (
          <div className="side-menu-user-card">
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
            <div className="side-menu-user-info">
              <div className="side-menu-user-name">{auth.user.name}</div>
              {auth.user.email && (
                <div className="side-menu-user-email">{auth.user.email}</div>
              )}
            </div>
            <button
              type="button"
              className="side-menu-logout-btn"
              onClick={() => {
                onClose();
                onLogout?.();
              }}
              title="Sign Out"
            >
              Sign out
            </button>
          </div>
        ) : (
          <div className="side-menu-login-box">
            <a
              href={getGoogleLoginUrl(currentPage)}
              className="youtube-google-login-btn"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
              </svg>
              Sign in with Google
            </a>
          </div>
        )}

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

            <button
              type="button"
              className={`side-menu-item ${currentPage === "youtube" ? "active" : ""}`}
              onClick={() => handleSelectPage("youtube")}
            >
              <span className="side-menu-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill={currentPage === "youtube" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.33z" />
                  <polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02" fill="currentColor" />
                </svg>
              </span>
              <span className="side-menu-label">YouTube</span>
            </button>

            <button
              type="button"
              className={`side-menu-item ${currentPage === "shorts" ? "active" : ""}`}
              onClick={() => handleSelectPage("shorts")}
            >
              <span className="side-menu-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill={currentPage === "shorts" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5" y="2" width="14" height="20" rx="3" />
                  <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" />
                </svg>
              </span>
              <span className="side-menu-label">Shorts</span>
            </button>

            {auth?.authenticated && (
              <button
                type="button"
                className={`side-menu-item ${currentPage === "upload" ? "active" : ""}`}
                onClick={() => handleSelectPage("upload")}
              >
                <span className="side-menu-icon" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </span>
                <span className="side-menu-label">Upload</span>
              </button>
            )}
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

          {visitors && (
            <>
              <div className="side-menu-section">
                <div className="side-menu-section-title">
                  Visitors <span className="side-menu-visitor-total">{visitors.length}</span>
                </div>
                <ul className="side-menu-visitors">
                  {(showAllVisitors ? visitors : visitors.slice(0, VISITORS_PREVIEW)).map((v) => {
                    const isSelf = selfVisitor && v.id === selfVisitor.id;
                    return (
                      <li key={v.id} className={`side-menu-visitor ${isSelf ? "self" : ""}`}>
                        <div className="side-menu-visitor-main">
                          <span className="side-menu-visitor-name">
                            {v.name || v.device}
                            {isSelf && <span className="side-menu-visitor-you"> (you)</span>}
                          </span>
                          <span className="side-menu-visitor-seen">{formatLastSeen(v.lastSeen)}</span>
                        </div>
                        <div className="side-menu-visitor-meta">
                          {v.name ? `${v.device} · ` : ""}
                          {v.ip} · {v.visits} {v.visits === 1 ? "visit" : "visits"}
                        </div>
                        {v.location && <div className="side-menu-visitor-location">📍 {v.location}</div>}
                      </li>
                    );
                  })}
                </ul>
                {visitors.length > VISITORS_PREVIEW && (
                  <button
                    type="button"
                    className="side-menu-visitor-link"
                    onClick={() => setShowAllVisitors((prev) => !prev)}
                  >
                    {showAllVisitors ? "Show fewer" : `Show all ${visitors.length}`}
                  </button>
                )}
                {selfVisitor && onVisitorNameChange && (
                  editingName ? (
                    <form
                      className="side-menu-visitor-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        onVisitorNameChange(nameDraft.trim());
                        setEditingName(false);
                      }}
                    >
                      <input
                        type="text"
                        value={nameDraft}
                        maxLength={40}
                        placeholder="Your name"
                        aria-label="Your name in the visitor list"
                        autoFocus
                        onChange={(e) => setNameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.stopPropagation();
                            e.nativeEvent.stopImmediatePropagation();
                            setEditingName(false);
                          }
                        }}
                      />
                      <button type="submit">Save</button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="side-menu-visitor-link"
                      onClick={() => {
                        setNameDraft(selfVisitor.name || "");
                        setEditingName(true);
                      }}
                    >
                      {selfVisitor.name ? "Change your name" : "Add your name"}
                    </button>
                  )
                )}
              </div>

              <div className="side-menu-divider" />
            </>
          )}

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
                    style={{
                      backgroundColor:
                        theme === "dark" ? c.darkColor : c.color,
                    }}
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

          <div className="side-menu-divider" />

          <div className="side-menu-footer">
            <div className="side-menu-version-row">
              <span className="side-menu-version-tag">Version</span>
              <span className="side-menu-version-val" title={APP_VERSION}>
                {APP_VERSION}
              </span>
            </div>
            {BUILD_TIME && (
              <div className="side-menu-build-time">Built {BUILD_TIME}</div>
            )}
          </div>
        </nav>
      </aside>
    </>
  );
}

