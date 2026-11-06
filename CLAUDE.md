# TylerTube

Self-hosted video streaming SPA: React 18 + Vite 5 (plain JS/JSX, no TS), a WebCodecs canvas
player (default) and a Plyr "Standard" player, Nginx in production on macOS.
User-facing docs: [README.md](README.md).

## Architecture

```
Browser ──► Nginx :8080 ──► dist/                (built SPA)
                     ├────► public/videos/       (/videos/*, byte-range MP4)
                     ├────► public/thumbnails/   (/thumbnails/*)
                     └─proxy─► stream server :5180    (/ws/mpeg1; npm run server)
```

- **Backend lives in `server/`**, mounted into Vite by `server/plugin.js` (`vite.config.js` is ~20 lines),
  plus `standalone.js` (production stream server, plain `http` + `drive-ws.js`, no Vite):
  - `catalog.js` → `virtual:video-library`: scans `public/videos/` → `src/data/videos.js` → `VIDEO_LIBRARY`.
  - Dev/preview middlewares: `thumbnails-middleware.js`, `stream-middleware.js`.
  - `drive-ws.js`: `/ws/mpeg1?file=…` spawns ffmpeg → H.264 Baseline + PCM binary frames over
    WebSocket (pure pieces and wire format in `webcodecs-stream.js`). The path name is historical
    (it used to carry MPEG1); kept so Nginx needn't change. Attached to Vite :5173 in dev and to
    `standalone.js` :5180 (`DRIVE_PORT`) in production.
  - `media-files.js` (`resolveLocalVideoFile`, path-traversal guard, ffprobe helpers), `shared.js`,
    `build-info.js` (version `define`s).
- **Player modes** (`playerMode` in `App.jsx`, toggled by D / the player buttons):
  - `"webcodecs"` (default where `window.VideoDecoder` exists): `VideoPlayer.jsx` renders
    `WebCodecsPlayer.jsx`; `webcodecs/WebCodecsEngine.js` decodes with `VideoDecoder` onto a canvas
    and plays PCM on an `AudioContext`, which is the master clock (video is presented against it).
    Canvas, not `<video>`, because Tesla's browser pauses `<video>` while driving.
  - `"standard"`: Plyr on a native `<video>`. Plyr stays mounted (hidden) in WebCodecs mode.
  - Both save to the same watch-progress store (`tylertube_watch_progress`). `VideoPlayer.jsx`
    keeps `positionRef` (exact last position) and hands it across a mode switch; a hidden Plyr
    doesn't report progress while WebCodecs is active.
- **State:** all app state is in `src/App.jsx` (no router, no store). Pages are switched by
  `currentPage` = `"home" | "history" | "favorites"`. Persistence is `localStorage` only.

## Directory guide

| Path | What |
|---|---|
| `server/` | Backend (see Architecture). Unit-tested in `tests/server.test.js`, `tests/standalone.test.js`, `tests/webcodecs.test.js` |
| `src/App.jsx` | All state, localStorage keys, keyboard shortcuts, page switch, mobile bottom nav |
| `src/lib/storage.js` | Never-throwing localStorage helpers (`readJSON`, `writeJSON`, `writeString`, …) |
| `src/utils/format.js` | Shared formatting (`formatDuration`) |
| `src/components/VideoPlayer.jsx` | Plyr player, standard/webcodecs switch, position handoff |
| `src/components/WebCodecsPlayer.jsx` | WebCodecs player component: state/refs, engine lifecycle, controls |
| `src/components/webcodecs/` | `WebCodecsEngine.js` (socket, decoder, audio, clock), `protocol.js`, `scheduler.js` (pure, tested), `PlayerChrome.jsx`, `SettingsMenu.jsx`, `playerUtils.js` |
| `src/components/{Navbar,SideMenu,VideoGrid}.jsx` | Top bar, hamburger drawer (nav, color themes, Desktop/Mobile layout), library grid |
| `src/components/{History,Favorites}Page.jsx` | Subpages (similar layout, different logic) |
| `src/data/themeColors.js` | `COLOR_THEMES` list (picker UI); CSS vars live in `src/styles/theme.css` |
| `src/data/videos.js` | Exposes `VIDEO_LIBRARY` from the virtual module (with fallback) |
| `src/version.js` | Reads `__APP_VERSION__` etc. injected via `define` (`server/build-info.js`) |
| `src/styles/` | Global CSS split by area; `index.css` `@import`s them **in cascade order** |
| `tests/` | `node:test` unit tests (server + pure helpers), ~100 ms |
| `scripts/check.mjs` | Static check: parse, undefined/unused identifiers, broken imports |
| `scripts/generate-thumbnails.js` | ffmpeg thumbnail generator (also imported by `server/`) |
| `scripts/generate-icons.py` | Regenerates favicons in `public/` |
| `scripts/launchd/` | LaunchAgent plist that keeps `npm run server` running (install steps in README) |
| `nginx.conf` | Production config (copied to `/opt/homebrew/etc/nginx/`) |
| `public/videos/`, `public/thumbnails/` | Media, ~51 GB, gitignored. **Never read or list recursively.** |

CSS map: `theme` (vars, accent themes) · `navbar` · `layout` · `player` (standard + floating) ·
`library` · `side-menu` · `subpages` · `mobile` · `webcodecs-player` (`.yt-*`) · `theme-picker`.
Use `grep -n "^/\* " src/styles/<file>.css` to find sections.

## Commands

```zsh
npm run dev          # Vite dev server :5173 (also hosts the stream WS)
npm run build        # Build to dist/ (also generates missing thumbnails)
npm run preview      # Serve dist/ with the same middlewares (:4173)
npm run server       # Production stream server :5180 (Nginx proxies /ws/mpeg1 here)
npm run thumbnails   # Generate missing thumbnails only
npm run check        # Static check of all JS/JSX (~0.5 s). Run after every edit.
npm test             # Unit tests (node:test, ~100 ms)
node --test tests/server.test.js          # Single test file
nginx -t && brew services restart nginx   # Reload production after build
launchctl kickstart -k gui/$(id -u)/com.tylertube.drive   # Restart stream server after server/ changes
```

No TypeScript or ESLint. Verify with `npm run check && npm test`, then `npm run build`;
for UI changes also check the page in a browser (desktop and mobile view mode).
Requires `ffmpeg` (with libx264)/`ffprobe` on PATH.

## Conventions

- Function components + hooks. Plyr and the WebCodecs engine are driven imperatively through refs;
  long-lived values that callbacks read go in `useRef` (see the `*Ref` pattern in `WebCodecsPlayer.jsx`).
- localStorage: key constants at the top of `App.jsx` (`tylertube_*`); read in a lazy
  `useState` initializer and write via `src/lib/storage.js` helpers (never raw `localStorage`).
- Pure logic goes in plain `.js` files (`server/`, `src/lib/`, `src/utils/`, `webcodecs/*.js`)
  so `node --test` can import it; add a test when you add one.
- Styling: global class names (`yt-*` for player chrome, `side-menu-*`, `mobile-*`), CSS
  custom properties for theme (`--accent`, …) set by `[data-theme]` and `[data-color-theme]`.
- Double quotes, semicolons, 2-space indent in JS; 4-space indent in CSS.

## Gotchas

- **Production WebCodecs playback needs `npm run server`** (LaunchAgent `com.tylertube.drive`, port 5180):
  Nginx proxies `/ws/mpeg1` there. It doesn't hot-reload; restart it after editing `server/`.
  launchd runs it with a fixed `PATH` (set in the plist) so ffmpeg/ffprobe resolve.
- **Catalog is baked at build time.** After adding videos in production, re-run `npm run build`.
  In dev, the watcher reloads it.
- `build.copyPublicDir: false`. Nginx serves media from `public/`. Root-level assets that `dist/`
  needs (favicons, manifest) are copied by a hard-coded list in `closeBundle()`
  in `server/plugin.js`. **New public asset → add it to that list.**
- Never render the Plyr `<video>` through JSX state changes; it's mounted once via ref so Plyr's
  DOM wrapper doesn't fight React.
- `drive-ws.js` (server) and `WebCodecsEngine.js` (client) share a JSON control protocol
  (`pause|resume|seek|speed|quality|loop` ↔ `meta|status|reset|ended|error`) plus the binary
  frame format in `server/webcodecs-stream.js` ↔ `webcodecs/protocol.js`. Change them together.
- File paths from clients go through `resolveLocalVideoFile()` (path-traversal guard). Keep any
  new file-serving code behind it or an equivalent `startsWith(videosDir + path.sep)` check.
- Mobile layout = `viewMode === "mobile"` (user toggle in the hamburger menu, not just viewport).
  Mobile overrides live in `src/styles/mobile.css`; check both modes after UI edits.
- Theme migration flag `tylertube_theme_migrated_v2` in `App.jsx`: don't remove casually.
- Nginx serves from the symlink `/Users/Shared/MyStreamingApp` → this repo.
- `scripts/check.mjs` relies on `@babel/parser`/`@babel/traverse`, installed transitively by
  `@vitejs/plugin-react`.

## Working here

- For WebCodecs player / stream work (`WebCodecsPlayer.jsx`, `webcodecs/`, `server/drive-ws.js`,
  `server/webcodecs-stream.js`, `styles/webcodecs-player.css`), delegate to the `drive-specialist` subagent.
- Before committing non-trivial changes, run the `reviewer` subagent on the diff.
- Workflows: `/add-persisted-setting`, `/add-page`, `/deploy-local` (in `.claude/skills/`).
