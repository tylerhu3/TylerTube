# TylerTube (React + Vite + Nginx)

A self-hosted video streaming web application built with **React**, **Vite**, **WebCodecs**, and **Nginx** on macOS (Apple Silicon). Features ffmpeg-backed WebCodecs canvas streaming, zero-copy file transfers, automatic watch-progress resume (`localStorage`), and a customizable single-page interface.

## Features

- **React Component Architecture:** Modular `<Navbar />`, `<SideMenu />`, `<VideoPlayer />`, `<WebCodecsPlayer />`, `<VideoGrid />`, `<HistoryPage />`, `<FavoritesPage />`, `<YouTubePage />`, and `<ShortsPage />` components with automatic watch-progress persistence, course/section folder filters, and visual progress bars on video cards.
- **YouTube & YouTube Shorts WebCodecs Streaming Portals:** Dedicated in-app portals to search YouTube videos and YouTube Shorts (vertical 9:16 cards) or paste any video/shorts URL (`youtube.com/watch?v=...`, `youtube.com/shorts/...`, `youtu.be/...`). Backed by `server/youtube.js` (`yt-dlp`), streams are piped directly into `ffmpeg` and packetized over WebSocket into TylerTube's canvas WebCodecs engine (`VideoDecoder` + `AudioContext`), bypassing Tesla browser driving pause restrictions.
- **Automatic Subdirectory, Subtitle & Thumbnail Discovery:** Custom Vite plugin (`videoCatalogPlugin` in `server/plugin.js`) recursively scans `public/videos/` (and any nested course/section folders), naturally sorts numbered lessons, URL-encodes special characters (`#`, `&`, spaces), automatically pairs matching `.srt`/`.vtt` subtitle files, and generates/serves `.jpg` video thumbnails in `public/thumbnails/` via `ffmpeg`.
- **WebCodecs Canvas Player:** Streams H.264 video + PCM audio over WebSocket into a `VideoDecoder` canvas and `AudioContext`, supporting quality/FPS/speed/sync controls and bypassing Tesla browser driving pause restrictions.
- **Zero-Copy Video Build Pipeline:** Vite builds the React UI into `dist/` (`copyPublicDir: false`) while Nginx serves `/videos/` directly from `public/videos/`, avoiding duplicating multi-gigabyte video files during builds.

## Project Structure

```text
TylerTube/
├── index.html                  # Vite HTML entry
├── package.json
├── vite.config.js              # Vite config (plugins + build settings only)
├── nginx.conf                  # Nginx: serves dist/ + public/, proxies /ws/mpeg1 to :5180
├── CLAUDE.md                   # Notes for AI-assisted development
├── server/                     # Backend: Vite plugin (dev/preview) + standalone stream server
│   ├── plugin.js               # Vite plugin: video catalog + middlewares
│   ├── catalog.js              # Scans public/videos/ into virtual:video-library
│   ├── stream-middleware.js    # /videos/* byte-range streaming
│   ├── thumbnails-middleware.js # /thumbnails/* (generated on demand)
│   ├── standalone.js           # Production stream server (npm run server, :5180)
│   ├── drive-ws.js             # /ws/mpeg1 ffmpeg → H.264 + PCM WebSocket (WebCodecs player)
│   ├── youtube.js              # /api/youtube/* routes, yt-dlp search & streaming pipeline
│   ├── media-files.js          # Safe path resolution, duration probing
│   ├── upload.js               # /api/upload* routes: key check, chunked uploads, folders
│   ├── upload-store.js         # Upload sessions on disk, free-space guard, ffprobe, final move
│   ├── upload-rules.js         # Pure name/path/chunk rules (tested)
│   ├── http-utils.js           # readBody / sendJSON / clientIp for the JSON APIs
│   ├── shared.js               # Shared constants/helpers
│   └── build-info.js           # Version/build stamps
├── tests/                      # node:test unit tests (npm test)
├── public/
│   ├── favicon*, site.webmanifest
│   ├── thumbnails/             # Auto-generated & custom poster images
│   └── videos/                 # Raw video files & subtitles (gitignored)
├── scripts/
│   ├── generate-thumbnails.js  # Parallel ffmpeg thumbnail generator
│   ├── generate-icons.py       # Favicon generator
│   ├── launchd/                # LaunchAgent plist for the stream server
│   └── check.mjs               # Static code check (npm run check)
└── src/
    ├── main.jsx                # React root mount
    ├── App.jsx                 # All app state, page switching
    ├── version.js              # Build version/time injected by Vite
    ├── lib/storage.js          # Safe localStorage helpers
    ├── lib/visitors.js         # Records this visit, fetches the visitor list
    ├── lib/uploader.js         # Chunked, resumable upload client (retries, readable errors)
    ├── utils/format.js         # Formatting helpers
    ├── styles/                 # Global CSS split by area (index.css imports in order)
    ├── data/
    │   ├── videos.js           # Video catalog (from virtual:video-library)
    │   └── themeColors.js      # Accent color themes
    └── components/
        ├── Navbar.jsx          # Search, theater/side-player/theme toggles
        ├── SideMenu.jsx        # Hamburger drawer: navigation, visitors, color themes, version
        ├── VideoGrid.jsx       # Library grid with watch-progress bars
        ├── VideoPlayer.jsx     # Player wrapper (WebCodecs player, floating side player, controls)
        ├── WebCodecsPlayer.jsx # WebCodecs canvas player (works while driving)
        ├── webcodecs/          # WebCodecs engine, wire protocol, scheduler, player chrome
        ├── HistoryPage.jsx     # Watch history
        ├── FavoritesPage.jsx   # Favorites
        ├── YouTubePage.jsx     # YouTube portal: search, URL launcher, stream to canvas
        ├── ShortsPage.jsx      # YouTube Shorts portal: 9:16 layout, search, stream to canvas
        ├── UploadPage.jsx      # Upload page: key, drop zone, queue
        └── upload/             # FolderPicker, UploadQueue
```

## Adding Videos & Playlists

The app automatically builds its catalog from `public/videos/` (supporting `.mp4`, `.webm`, `.mov`, and `.m4v` files, plus matching `.vtt`/`.srt` subtitles):

- **Top-level folder → Course playlist:** `public/videos/<Course Name>/video.mp4` creates a **Course** filter tab.
- **Nested subfolder → Section filter:** `public/videos/<Course Name>/<Section Name>/video.mp4` creates a **Section** filter under that course.
- **Root files:** Videos placed directly in `public/videos/video.mp4` are grouped under the `General` course and `Main` section.
- **Active playlist behavior:** Selecting a course or section scopes Previous/Next controls and auto-advance playback to that filtered playlist.

**How updates are detected:**
- **Development (`npm run dev`):** Vite watches `public/videos/` for added or removed files and reloads the catalog live.
- **Production (`npm run build` + Nginx):** The catalog is compiled into `dist/` at build time. Re-run `npm run build` after adding new videos or folders so they appear in the UI.

### Uploading from the browser

The hamburger menu's **Upload** page adds videos (`.mp4`/`.m4v`/`.mov`/`.webm`), subtitles
(`.vtt`/`.srt`) and posters (`.jpg`/`.png`/`.webp`) to `public/videos/`, and creates course and
section folders (up to 3 levels deep).

- **Turn it on** by setting a key of at least 12 characters: put it on the first line of
  `data/upload-key` (gitignored, read on every request, so no restart needed) or set
  `TYLERTUBE_UPLOAD_KEY` in the stream server's environment. With no key, uploads are off. Enter
  the same key on the Upload page; it's saved on that device only. After 10 wrong keys from one
  IP, that IP is blocked for 15 minutes.
- **Large files are sent in 8 MB chunks** (Cloudflare caps a request at 100 MB). A dropped
  connection is retried automatically, and **Resume** continues where it stopped, even after a
  reload (same file, folder and name). Unfinished uploads are kept in `public/videos/.uploads/`
  and deleted after 24 h.
- **Safety checks:** names with `/ \ :`, a leading dot or control characters are refused;
  existing files are never overwritten (you're offered `Name (2).mp4` instead); every video is
  checked with `ffprobe` and discarded if it isn't one (non-H.264/AAC files are kept with a
  warning, since they're transcoded on the fly by WebCodecs); and the server keeps 5 GB free
  (`TYLERTUBE_UPLOAD_RESERVE_GB` to change). Max file size is 50 GB.
- **When it shows up:** in production the tunnel keeper rebuilds about a minute after the
  folder stops changing, and the queue switches to **Live** once that's done. In dev it's live
  right away (reload to see it).

Production needs the stream server restarted and Nginx's `/api/upload` block (larger body size,
no request buffering) copied in; see the Quick Start steps.

## Video Thumbnails

Thumbnails are automatically generated and paired with every video in `public/videos/` (requires `ffmpeg`, e.g., `brew install ffmpeg`):

- **Automatic Batch Generation:** Running `npm run dev` or `npm run build` automatically executes `scripts/generate-thumbnails.js`, which mirrors the `public/videos/` folder hierarchy inside `public/thumbnails/` and extracts a 480p `.jpg` frame (at `00:00:05`, with fallback for shorter clips) for any video missing a thumbnail.
- **Manual Generation Command:** You can also generate missing thumbnails at any time without rebuilding by running:
  ```zsh
  npm run thumbnails
  ```
- **On-the-Fly Dev Fallback:** If you drop a new video into `public/videos/` while `npm run dev` is running, Vite's `/thumbnails/` middleware automatically extracts and caches its `.jpg` thumbnail on the first request.
- **Custom Thumbnails:** To override the auto-generated frame for a specific video, place an image with the same base filename (`.jpg`, `.jpeg`, `.png`, or `.webp`) either:
  1. Alongside the video in `public/videos/<Course>/<Section>/<VideoName>.png`, or
  2. Inside `public/thumbnails/<Course>/<Section>/<VideoName>.jpg`.

## Quick Start

### 0. Clone (including `redirect-site/` submodule)

```bash
git clone --recurse-submodules https://github.com/tylerhu3/TylerTube.git
```

If you already cloned without `--recurse-submodules`, run `git submodule update --init` (or let `scripts/tunnel.mjs` clone `redirect-site/` automatically on first publish).

### Windows Automated Setup (PowerShell)

On a fresh Windows machine, run the resumable setup script from the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
```

It checks and installs all required dependencies (skipping anything already up to date):
- **Git**, **Node.js LTS** (≥ 18.15), **Python 3** (≥ 3.9), **FFmpeg/FFprobe**, **yt-dlp**, **cloudflared** (via `winget`)
- **Nginx for Windows** (downloaded to `C:\nginx` by default; pass `-NginxDir "D:\nginx"` to customize)
- **npm packages** (`npm install`), `.env` scaffolding, `redirect-site/` submodule init, and Git/GitHub readiness checks

At the end, the script prints a summary of what was already installed, what it installed, anything needing manual intervention (such as GitHub sign-in, Git identity, or `.env` OAuth keys), and the exact next steps to start the server (`npm run deploy:public`). Safe to re-run at any time to resume.

### 1. Install Dependencies & Run in Development

```zsh
npm install
npm run dev
```
Open `http://localhost:5173` to develop with hot module replacement (HMR). Vite automatically serves any `.mp4` files placed in `public/videos/`.

### 2. Build for Production (Nginx)

```zsh
npm run build
```
This compiles the production React bundle into `dist/`.

### 3. Install, Configure & Start Nginx on macOS (Apple Silicon)

```zsh
# Install Nginx via Homebrew
brew install nginx

# Symlink project to /Users/Shared/MyStreamingApp
ln -s /Users/tylerhu/Projects/TylerTube /Users/Shared/MyStreamingApp
chmod -R 755 /Users/tylerhu/Projects/TylerTube

# Copy nginx.conf to Homebrew Nginx
cp /opt/homebrew/etc/nginx/nginx.conf /opt/homebrew/etc/nginx/nginx.conf.bak
cp /Users/tylerhu/Projects/TylerTube/nginx.conf /opt/homebrew/etc/nginx/nginx.conf

# Validate and restart Nginx
nginx -t
brew services restart nginx
```

### 4. Run the Stream Server (WebCodecs player)

The WebCodecs player streams over a WebSocket (`/ws/mpeg1`) that Nginx proxies to a small Node server on `127.0.0.1:5180`. Vite isn't needed in production.

Run it by hand:

```bash
npm run server
```

Or install it as a LaunchAgent so it starts at login and restarts if it crashes:

```bash
cp scripts/launchd/com.tylertube.drive.plist ~/Library/LaunchAgents/
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tylertube.drive.plist
```

The plist assumes Homebrew's `/opt/homebrew/bin/node`; if `which node` says otherwise (nvm, Volta), edit `ProgramArguments` before installing. Check it with `curl http://127.0.0.1:5180/healthz` (→ `ok`); logs go to `/tmp/tylertube-drive.log`. After pulling server changes, restart it with `launchctl kickstart -k gui/$(id -u)/com.tylertube.drive`. Set `DRIVE_PORT` to use another port (and update `nginx.conf` to match).

The WebCodecs player streams at 24 fps by default. Pick Auto (adapts to the device), Source, 60 or 30 in the player's settings menu; the choice is remembered per browser.

### 5. Stream on Your Mac & Home Network

- **On your Mac:** Open `http://localhost:8080`
- **On other devices (iPhone, iPad, Apple TV, Smart TV):**
  Run `ipconfig getifaddr en0` to find your Mac's LAN IP, then visit `http://<YOUR_MAC_IP>:8080`.

### 6. Stream Outside Your Home Network (Cloudflare Tunnel)

To generate a public `https://` link accessible from anywhere (without router port forwarding):

```zsh
# Install cloudflared via Homebrew
brew install cloudflared

# Start a tunnel pointing to your local Nginx server
cloudflared tunnel --url http://localhost:8080
```
Copy the `https://xxxx.trycloudflare.com` URL printed in the terminal to stream from any device outside your home network.

#### Stable public address (Netlify redirect) + one-command deploy

The quick-tunnel URL changes on every restart, so a Netlify site
([tylerhu3/RedirectUrl](https://github.com/tylerhu3/RedirectUrl), tracked as a git submodule at
`redirect-site/`) 302-redirects to whatever the current one is.

```bash
npm run deploy:public            # check, test, build, Nginx, stream server, tunnel, redirect
npm run deploy:public -- --dry-run   # build + smoke test; shows what it would push, changes nothing
npm run tunnel status            # running tunnel(s) for :8080 and the published URL
```

Both `scripts/deploy-public.mjs` and `scripts/tunnel.mjs` detect your OS and automatically dispatch
to the macOS (`*.mac.mjs`) or Windows (`*.win.mjs`) implementation:

- **macOS:** `deploy:public` copies `nginx.conf` into Homebrew Nginx, restarts `com.tylertube.drive`,
  and installs the LaunchAgent `com.tylertube.tunnel` (`scripts/tunnel-watch.mjs`). Logs:
  `/tmp/tylertube-tunnel.log`, `/tmp/tylertube-cloudflared.log`, `/tmp/tylertube-drive.log`.
- **Windows:** Requires `nginx` (e.g. `C:\nginx` or set `NGINX_DIR`), `cloudflared`, `ffmpeg`/`ffprobe`,
  and Git authenticated to GitHub. `deploy:public` rewrites `nginx.conf` with your Windows repo path
  into `<NGINX_DIR>\conf\nginx.conf`, starts/reloads Nginx, restarts `server/standalone.js`, starts
  `scripts/tunnel-watch.mjs` in the background, and publishes the tunnel URL. Logs go to `%TEMP%\tylertube-*.log`.

The same keeper also rebuilds when you add, rename or remove files in `public/videos/`: about a
minute after the folder stops changing it runs `npm run build` (new thumbnails included), and the
new videos appear on the next page load. Each rebuild ships whatever code is in the working tree.
Turn it off with `AUTO_REBUILD=0` in the plist's `EnvironmentVariables`.

Watch progress, history, favorites, last video and theme are stored server-side too
(`/api/state` on the stream server, file `data/user-state.json`), so a new tunnel URL (= empty
localStorage) still shows your history. Dev uses `data/user-state.dev.json`.

### Visitor log

Every page load is recorded by the stream server (`POST /api/visit`, `server/visitors.js`): browser
and device, IP, first/last seen and a visit count (a new visit after 30 minutes away). The
hamburger menu's **Visitors** section lists them (`GET /api/visitors`), and visitors can add a
name there. The list in the menu masks IPs (`73.12.x.x`), since anyone with the tunnel URL can
open it; full records stay in `data/visitors.json` (gitignored; dev: `data/visitors.dev.json`,
override with `TYLERTUBE_VISITORS_FILE`), capped at 500 visitors. To remove an entry, edit that
file and restart the stream server. Nginx passes the real client IP through (`X-Real-IP`,
`X-Forwarded-For`; cloudflared adds `CF-Connecting-IP`), so recopy `nginx.conf` after updating.
