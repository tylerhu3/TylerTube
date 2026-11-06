# TylerTube (React + Vite + Nginx)

A self-hosted video streaming web application built with **React**, **Vite**, **Plyr.io**, and **Nginx** on macOS (Apple Silicon). Features HTTP byte-range MP4 streaming, zero-copy file transfers, automatic watch-progress resume (`localStorage`), and a dark-themed single-page interface.

## Features

- **React Component Architecture:** Modular `<Navbar />`, `<SideMenu />`, `<VideoPlayer />`, `<WebCodecsPlayer />`, `<VideoGrid />`, `<HistoryPage />` and `<FavoritesPage />` components with automatic watch-progress persistence, course/section folder filters, and visual progress bars on video cards.
- **Automatic Subdirectory, Subtitle & Thumbnail Discovery:** Custom Vite plugin (`videoCatalogPlugin` in `server/plugin.js`) recursively scans `public/videos/` (and any nested course/section folders), naturally sorts numbered lessons, URL-encodes special characters (`#`, `&`, spaces), automatically pairs matching `.srt`/`.vtt` subtitle files, and generates/serves `.jpg` video thumbnails in `public/thumbnails/` via `ffmpeg`.
- **Safe Plyr.io React Integration:** Imperative `<video>` mounting via React `useRef` so Plyr's DOM wrapper never conflicts with React re-renders.
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
│   ├── media-files.js          # Safe path resolution, duration probing
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
    ├── utils/format.js         # Formatting helpers
    ├── styles/                 # Global CSS split by area (index.css imports in order)
    ├── data/
    │   ├── videos.js           # Video catalog (from virtual:video-library)
    │   └── themeColors.js      # Accent color themes
    └── components/
        ├── Navbar.jsx          # Search, theater/side-player/player-mode/theme toggles
        ├── SideMenu.jsx        # Hamburger drawer: navigation, color themes, version
        ├── VideoGrid.jsx       # Library grid with watch-progress bars
        ├── VideoPlayer.jsx     # Plyr player; switches to the WebCodecs player
        ├── WebCodecsPlayer.jsx # WebCodecs canvas player (default; works while driving)
        ├── webcodecs/          # WebCodecs engine, wire protocol, scheduler, player chrome
        ├── HistoryPage.jsx     # Watch history
        └── FavoritesPage.jsx   # Favorites
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

The WebCodecs player (the default) streams over a WebSocket (`/ws/mpeg1`) that Nginx proxies to a small Node server on `127.0.0.1:5180`. Vite isn't needed in production.

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
