# TylerTube

Self-hosted video streaming SPA: React 18 + Vite 5 (plain JS/JSX, no TS), Plyr player,
JSMpeg-based "Drive" player, Nginx in production on macOS. User-facing docs: [README.md](README.md).

## Architecture

```
Browser ──► Nginx :8080 ──► dist/                (built SPA)
                     ├────► public/videos/       (/videos/*, byte-range MP4)
                     ├────► public/thumbnails/   (/thumbnails/*)
                     └─proxy─► Vite dev server :5173  (/ws/mpeg1, /api/*)
```

- **Backend lives in `vite.config.js`** (`videoCatalogPlugin`). It is not just build config:
  - `virtual:video-library`: scans `public/videos/` at build/dev time → `src/data/videos.js` → `VIDEO_LIBRARY`.
  - Dev/preview middlewares: thumbnails (on-the-fly ffmpeg), video streaming, `/api/live-audio`.
  - `attachDriveWebSocketServer`: `/ws/mpeg1?file=…` spawns ffmpeg → MPEG1 over WebSocket → JSMpeg canvas.
- **Standard playback:** `VideoPlayer.jsx` (Plyr on a native `<video>`).
- **Drive playback:** `VideoPlayer.jsx` renders `DriveVideoPlayer.jsx` when `playerMode === "drive"`.
  Video is decoded by JSMpeg into a canvas (Tesla's browser pauses `<video>` while driving).
- **State:** all app state is in `src/App.jsx` (no router, no store). Pages are switched by
  `currentPage` = `"home" | "history" | "favorites"`. Persistence is `localStorage` only.

## Directory guide

| Path | What |
|---|---|
| `src/App.jsx` | All state, localStorage, keyboard shortcuts, page switch, mobile bottom nav |
| `src/components/VideoPlayer.jsx` | Plyr player, standard/drive switch |
| `src/components/DriveVideoPlayer.jsx` | Drive player (~2k lines; lines ~34–480 monkey-patch JSMpeg) |
| `src/components/{Navbar,SideMenu,VideoGrid}.jsx` | Top bar, hamburger drawer (nav + color themes), library grid |
| `src/components/{History,Favorites}Page.jsx` | Subpages; near-duplicates of each other |
| `src/data/themeColors.js` | `COLOR_THEMES` list (picker UI); CSS vars live in `styles.css` |
| `src/data/videos.js` | Exposes `VIDEO_LIBRARY` from the virtual module (with fallback) |
| `src/version.js` | Reads `__APP_VERSION__` etc. injected by `define` in `vite.config.js` |
| `src/styles.css` | ALL styles (~3.1k lines), sectioned by `/* Section */` comments |
| `scripts/generate-thumbnails.js` | ffmpeg thumbnail generator (also imported by `vite.config.js`) |
| `scripts/generate-icons.py` | Regenerates favicons in `public/` |
| `nginx.conf` | Production config (copied to `/opt/homebrew/etc/nginx/`) |
| `public/videos/`, `public/thumbnails/` | Media, ~51 GB, gitignored. **Never read or list recursively.** |
| `public/jsmpeg.min.js` | Vendored, loaded globally via `<script>` in `index.html`. Don't read. |

Find things in `styles.css` with `grep -n "^/\* " src/styles.css` instead of reading the whole file.

## Commands

```zsh
npm run dev          # Vite dev server :5173 (also hosts Drive WS + /api)
npm run build        # Build to dist/ (also generates missing thumbnails)
npm run preview      # Serve dist/ with the same middlewares (:4173)
npm run thumbnails   # Generate missing thumbnails only
nginx -t && brew services restart nginx   # Reload production after build
node --check vite.config.js               # Quick syntax check of server code
```

There are **no tests, no linter, no typecheck**. `npm run build` is the verification step;
for UI changes also check the page in a browser (desktop and mobile view mode).
Requires `ffmpeg`/`ffprobe` on PATH.

## Conventions

- Function components + hooks. Plyr/JSMpeg are driven imperatively through refs; long-lived
  values that callbacks read go in `useRef` (see the `*Ref` pattern in `DriveVideoPlayer.jsx`).
- localStorage: key constants at the top of `App.jsx` (`tylertube_*`), lazy `useState`
  initializer + `try/catch` on every read/write. Keep that pattern.
- Styling: global class names (`yt-*` for player chrome, `side-menu-*`, `mobile-*`), CSS
  custom properties for theme (`--accent`, …) set by `[data-theme]` and `[data-color-theme]`.
- Double quotes, semicolons, 2-space indent in JS; 4-space indent in CSS.

## Gotchas

- **Production Drive mode needs `npm run dev` running**: Nginx proxies `/ws/mpeg1` and `/api/` to :5173.
- **Catalog is baked at build time.** After adding videos in production, re-run `npm run build`.
  In dev, the watcher reloads it.
- `build.copyPublicDir: false`. Nginx serves media from `public/`. Root-level assets that `dist/`
  needs (favicons, `jsmpeg.min.js`, manifest) are copied by a hard-coded list in `closeBundle()`
  in `vite.config.js`. **New public asset → add it to that list.**
- Never render the Plyr `<video>` through JSX state changes; it's mounted once via ref so Plyr's
  DOM wrapper doesn't fight React.
- `window.JSMpeg` is a global from `index.html` and is patched at runtime by `ensureJSMpegPatched()`.
- File paths from clients go through `resolveLocalVideoFile()` (path-traversal guard). Keep any
  new file-serving code behind it or an equivalent `startsWith(videosDir + path.sep)` check.
- Mobile layout = `viewMode === "mobile"` (user toggle, not just viewport). Mobile overrides
  live in the `/* Mobile ... */` sections of `styles.css`; check both modes after UI edits.
- Theme migration flag `tylertube_theme_migrated_v2` in `App.jsx`: don't remove casually.
- Nginx serves from the symlink `/Users/Shared/MyStreamingApp` → this repo.
- `/api/live-audio` is not referenced from `src/` today.

## Working here

- For Drive-player work (DriveVideoPlayer, JSMpeg patch, WS/ffmpeg server, `.yt-*` CSS),
  delegate to the `drive-specialist` subagent to keep that ~25k-token surface out of context.
- Before committing non-trivial changes, run the `reviewer` subagent on the diff.
- Workflows: `/add-persisted-setting`, `/add-page`, `/deploy-local` (in `.claude/skills/`).
