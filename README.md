# TylerTube (React + Vite + Nginx)

A self-hosted video streaming web application built with **React**, **Vite**, **Plyr.io**, and **Nginx** on macOS (Apple Silicon). Features HTTP byte-range MP4 streaming, zero-copy file transfers, automatic watch-progress resume (`localStorage`), and a dark-themed single-page interface.

## Features

- **React Component Architecture:** Modular `<Navbar />`, `<VideoPlayer />`, and `<VideoGrid />` components with automatic watch-progress persistence, course/section folder filters, and visual progress bars on video cards.
- **Automatic Subdirectory & Subtitle Discovery:** Custom Vite plugin (`videoCatalogPlugin`) recursively scans `public/videos/` (and any nested course/section folders), naturally sorts numbered lessons, URL-encodes special characters (`#`, `&`, spaces), and automatically pairs matching `.srt`/`.vtt` subtitle files.
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
│   ├── thumbnails/             # Optional poster images (.jpg, .webp)
│   └── videos/                 # Raw .mp4 video files
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
