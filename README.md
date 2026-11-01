# TylerTube (React + Vite + Nginx)

A self-hosted video streaming web application built with **React**, **Vite**, **Plyr.io**, and **Nginx** on macOS (Apple Silicon). Features HTTP byte-range MP4 streaming, zero-copy file transfers, automatic watch-progress resume (`localStorage`), and a dark-themed single-page interface.

## Features

- **React Component Architecture:** Modular `<Navbar />`, `<VideoPlayer />`, and `<VideoGrid />` components with automatic watch-progress persistence, course/section folder filters, and visual progress bars on video cards.
- **Automatic Subdirectory, Subtitle & Thumbnail Discovery:** Custom Vite plugin (`videoCatalogPlugin`) recursively scans `public/videos/` (and any nested course/section folders), naturally sorts numbered lessons, URL-encodes special characters (`#`, `&`, spaces), automatically pairs matching `.srt`/`.vtt` subtitle files, and generates/serves `.jpg` video thumbnails in `public/thumbnails/` via `ffmpeg`.
- **Safe Plyr.io React Integration:** Imperative `<video>` mounting via React `useRef` so Plyr's DOM wrapper never conflicts with React re-renders.
- **Zero-Copy Video Build Pipeline:** Vite builds the React UI into `dist/` (`copyPublicDir: false`) while Nginx serves `/videos/` directly from `public/videos/`, avoiding duplicating multi-gigabyte video files during builds.

## Project Structure

```text
TylerTube/
├── index.html                  # Vite HTML entry point
├── package.json                # React, Plyr, and Vite dependencies
├── vite.config.js              # Vite configuration
├── nginx.conf                  # Nginx config serving dist/ and public/videos/
├── .gitignore                  # Ignores node_modules, dist, and raw videos
├── public/
│   ├── thumbnails/             # Auto-generated & custom poster images (.jpg, .png, .webp)
│   └── videos/                 # Raw .mp4/.webm/.mov/.m4v video files & subtitles
├── scripts/
│   └── generate-thumbnails.js  # Parallel ffmpeg thumbnail generator
└── src/
    ├── main.jsx                # React root mount
    ├── App.jsx                 # Main state (active video, search, watch progress, theater mode)
    ├── styles.css              # Dark theme & responsive gallery styles
    ├── data/
    │   └── videos.js           # Video catalog metadata
    └── components/
        ├── Navbar.jsx          # Search input & Theater Mode toggle
        ├── VideoPlayer.jsx     # Ref-isolated Plyr.io player & custom transport controls
        └── VideoGrid.jsx       # Responsive gallery grid with watch-progress bars
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

### 4. Stream on Your Mac & Home Network

- **On your Mac:** Open `http://localhost:8080`
- **On other devices (iPhone, iPad, Apple TV, Smart TV):**
  Run `ipconfig getifaddr en0` to find your Mac's LAN IP, then visit `http://<YOUR_MAC_IP>:8080`.

### 5. Stream Outside Your Home Network (Cloudflare Tunnel)

To generate a public `https://` link accessible from anywhere (without router port forwarding):

```zsh
# Install cloudflared via Homebrew
brew install cloudflared

# Start a tunnel pointing to your local Nginx server
cloudflared tunnel --url http://localhost:8080
```
Copy the `https://xxxx.trycloudflare.com` URL printed in the terminal to stream from any device outside your home network.
