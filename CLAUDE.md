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

- **Backend lives in `server/`**, mounted into Vite by `server/plugin.js` (`vite.config.js` is ~20 lines):
  - `catalog.js` → `virtual:video-library`: scans `public/videos/` → `src/data/videos.js` → `VIDEO_LIBRARY`.
  - Dev/preview middlewares: `thumbnails-middleware.js`, `stream-middleware.js`, `live-audio.js` (`/api/live-audio`).
  - `drive-ws.js`: `/ws/mpeg1?file=…` spawns ffmpeg → MPEG1 over WebSocket → JSMpeg canvas.
  - `media-files.js` (`resolveLocalVideoFile`, path-traversal guard), `shared.js`, `build-info.js` (version `define`s).
- **Standard playback:** `VideoPlayer.jsx` (Plyr on a native `<video>`).
- **Drive playback:** `VideoPlayer.jsx` renders `DriveVideoPlayer.jsx` when `playerMode === "drive"`.
  Video is decoded by JSMpeg into a canvas (Tesla's browser pauses `<video>` while driving).
- **State:** all app state is in `src/App.jsx` (no router, no store). Pages are switched by
  `currentPage` = `"home" | "history" | "favorites"`. Persistence is `localStorage` only.

## Directory guide

| Path | What |
|---|---|
| `server/` | Dev/preview backend (see Architecture). Unit-tested in `tests/server.test.js` |
| `src/App.jsx` | All state, localStorage keys, keyboard shortcuts, page switch, mobile bottom nav |
| `src/lib/storage.js` | Never-throwing localStorage helpers (`readJSON`, `writeJSON`, `writeString`, …) |
| `src/utils/format.js` | Shared formatting (`formatDuration`) |
| `src/components/VideoPlayer.jsx` | Plyr player, standard/drive switch |
| `src/components/DriveVideoPlayer.jsx` | Drive player (~1.4k lines): state/refs, stream lifecycle, controls |
| `src/components/drive/` | `jsmpegPatch.js` (patches `window.JSMpeg`), `DriveSettingsMenu.jsx`, `driveUtils.js` |
| `src/components/{Navbar,SideMenu,VideoGrid}.jsx` | Top bar, hamburger drawer (nav + color themes), library grid |
| `src/components/{History,Favorites}Page.jsx` | Subpages (similar layout, different logic) |
| `src/data/themeColors.js` | `COLOR_THEMES` list (picker UI); CSS vars live in `src/styles/theme.css` |
| `src/data/videos.js` | Exposes `VIDEO_LIBRARY` from the virtual module (with fallback) |
| `src/version.js` | Reads `__APP_VERSION__` etc. injected via `define` (`server/build-info.js`) |
| `src/styles/` | Global CSS split by area; `index.css` `@import`s them **in cascade order** |
| `tests/` | `node:test` unit tests (server + pure helpers), ~50 ms |
| `scripts/check.mjs` | Static check: parse, undefined/unused identifiers, broken imports |
| `scripts/generate-thumbnails.js` | ffmpeg thumbnail generator (also imported by `server/`) |
| `scripts/generate-icons.py` | Regenerates favicons in `public/` |
| `nginx.conf` | Production config (copied to `/opt/homebrew/etc/nginx/`) |
| `public/videos/`, `public/thumbnails/` | Media, ~51 GB, gitignored. **Never read or list recursively.** |
| `public/jsmpeg.min.js` | Vendored, loaded globally via `<script>` in `index.html`. Don't read. |

CSS map: `theme` (vars, accent themes) · `navbar` · `layout` · `player` (standard + floating) ·
`library` · `side-menu` · `subpages` · `mobile` · `drive-player` (`.yt-*`) · `theme-picker`.
Use `grep -n "^/\* " src/styles/<file>.css` to find sections.

## Commands

```zsh
npm run dev          # Vite dev server :5173 (also hosts Drive WS + /api)
npm run build        # Build to dist/ (also generates missing thumbnails)
npm run preview      # Serve dist/ with the same middlewares (:4173)
npm run thumbnails   # Generate missing thumbnails only
npm run check        # Static check of all JS/JSX (~0.5 s). Run after every edit.
npm test             # Unit tests (node:test, ~50 ms)
node --test tests/server.test.js          # Single test file
nginx -t && brew services restart nginx   # Reload production after build
```

No TypeScript or ESLint. Verify with `npm run check && npm test`, then `npm run build`;
for UI changes also check the page in a browser (desktop and mobile view mode).
Requires `ffmpeg`/`ffprobe` on PATH.

## Conventions

- Function components + hooks. Plyr/JSMpeg are driven imperatively through refs; long-lived
  values that callbacks read go in `useRef` (see the `*Ref` pattern in `DriveVideoPlayer.jsx`).
- localStorage: key constants at the top of `App.jsx` (`tylertube_*`); read in a lazy
  `useState` initializer and write via `src/lib/storage.js` helpers (never raw `localStorage`).
- Pure logic goes in plain `.js` files (`server/`, `src/lib/`, `src/utils/`, `drive/driveUtils.js`)
  so `node --test` can import it; add a test when you add one.
- Styling: global class names (`yt-*` for player chrome, `side-menu-*`, `mobile-*`), CSS
  custom properties for theme (`--accent`, …) set by `[data-theme]` and `[data-color-theme]`.
- Double quotes, semicolons, 2-space indent in JS; 4-space indent in CSS.

## Gotchas

- **Production Drive mode needs `npm run dev` running**: Nginx proxies `/ws/mpeg1` and `/api/` to :5173.
- **Catalog is baked at build time.** After adding videos in production, re-run `npm run build`.
  In dev, the watcher reloads it.
- `build.copyPublicDir: false`. Nginx serves media from `public/`. Root-level assets that `dist/`
  needs (favicons, `jsmpeg.min.js`, manifest) are copied by a hard-coded list in `closeBundle()`
  in `server/plugin.js`. **New public asset → add it to that list.**
- Never render the Plyr `<video>` through JSX state changes; it's mounted once via ref so Plyr's
  DOM wrapper doesn't fight React.
- `window.JSMpeg` is a global from `index.html`, patched at runtime by `ensureJSMpegPatched()`
  (`drive/jsmpegPatch.js`). `drive-ws.js` (server) and `DriveVideoPlayer.jsx` (client) share a
  JSON message protocol (`pause|resume|seek|speed|quality|loop` ↔ `meta|status|reset|ended|error`).
- File paths from clients go through `resolveLocalVideoFile()` (path-traversal guard). Keep any
  new file-serving code behind it or an equivalent `startsWith(videosDir + path.sep)` check.
- Mobile layout = `viewMode === "mobile"` (user toggle, not just viewport). Mobile overrides
  live in `src/styles/mobile.css`; check both modes after UI edits.
- Theme migration flag `tylertube_theme_migrated_v2` in `App.jsx`: don't remove casually.
- Nginx serves from the symlink `/Users/Shared/MyStreamingApp` → this repo.
- `/api/live-audio` is not referenced from `src/` today.
- `scripts/check.mjs` relies on `@babel/parser`/`@babel/traverse`, installed transitively by
  `@vitejs/plugin-react`.

## Working here

- For Drive-player work (`DriveVideoPlayer.jsx`, `drive/`, `server/drive-ws.js`,
  `styles/drive-player.css`), delegate to the `drive-specialist` subagent.
- Before committing non-trivial changes, run the `reviewer` subagent on the diff.
- Workflows: `/add-persisted-setting`, `/add-page`, `/deploy-local` (in `.claude/skills/`).
