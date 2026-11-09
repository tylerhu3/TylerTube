// Vite plugin: virtual:video-library catalog, thumbnails at build, dev/preview middlewares.
import fs from "node:fs";
import path from "node:path";
import { generateAllThumbnails } from "../scripts/generate-thumbnails.js";
import { scanVideosDirectory } from "./catalog.js";
import { createThumbnailsMiddleware } from "./thumbnails-middleware.js";
import { createVideoStreamMiddleware } from "./stream-middleware.js";
import { attachDriveWebSocketServer } from "./drive-ws.js";
import { createUserStateHandler, createUserStateStore } from "./user-state.js";
import { createVisitorStore, createVisitorsHandler, defaultGeolocate } from "./visitors.js";
import { computeVideoSignature, recordSignature } from "./video-signature.js";
import { createUploadHandler } from "./upload.js";
import { createUploadStore } from "./upload-store.js";

// Dev/preview keep their own state file so testing never touches production history.
function devUserStateHandler() {
  const file = path.resolve(process.cwd(), "data/user-state.dev.json");
  return createUserStateHandler(createUserStateStore(file));
}

function devVisitorsHandler() {
  const file = path.resolve(process.cwd(), "data/visitors.dev.json");
  return createVisitorsHandler(createVisitorStore(file, { geolocate: defaultGeolocate() }));
}

// Same library and key as production (dev uploads land in the real public/videos/). Vite's
// watcher reloads the catalog itself, so the catalog is always "live" here.
function devUploadHandler(videosDir) {
  return createUploadHandler(createUploadStore({ videosDir }));
}

export function videoCatalogPlugin() {
  const virtualModuleId = "virtual:video-library";
  const resolvedVirtualModuleId = "\0" + virtualModuleId;
  let buildSignature = null; // public/videos/ as of this build's catalog scan
  let isBuild = false;

  return {
    name: "tylertube-video-catalog",
    configResolved(config) {
      isBuild = config.command === "build";
    },
    async buildStart() {
      const videosDir = path.resolve(process.cwd(), "public/videos");
      if (isBuild) buildSignature = computeVideoSignature(videosDir).signature;
      const thumbnailsDir = path.resolve(process.cwd(), "public/thumbnails");
      await generateAllThumbnails({
        videosRoot: videosDir,
        thumbnailsRoot: thumbnailsDir
      });
    },
    closeBundle() {
      // Ensure icons and standalone assets are copied to dist/ even with copyPublicDir: false
      const distDir = path.resolve(process.cwd(), "dist");
      if (!fs.existsSync(distDir)) return;
      // Lets the tunnel keeper's auto-rebuild know which videos this build includes.
      // (The dev server also runs closeBundle on shutdown, hence the isBuild guard.)
      if (isBuild && buildSignature) recordSignature(buildSignature);

      const assetsToCopy = [
        "favicon.svg",
        "favicon.ico",
        "favicon-16x16.png",
        "favicon-32x32.png",
        "favicon-48x48.png",
        "favicon-192x192.png",
        "favicon-512x512.png",
        "apple-touch-icon.png",
        "site.webmanifest"
      ];

      for (const asset of assetsToCopy) {
        const srcPath = path.resolve(process.cwd(), "public", asset);
        const destPath = path.join(distDir, asset);
        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    },
    resolveId(id) {
      if (id === virtualModuleId) {
        return resolvedVirtualModuleId;
      }
    },
    load(id) {
      if (id === resolvedVirtualModuleId) {
        const videosDir = path.resolve(process.cwd(), "public/videos");
        const thumbnailsDir = path.resolve(process.cwd(), "public/thumbnails");
        const videos = scanVideosDirectory(videosDir, thumbnailsDir);
        return `export const SCANNED_VIDEOS = ${JSON.stringify(videos)};`;
      }
    },
    configureServer(server) {
      const videosDir = path.resolve(process.cwd(), "public/videos");
      const thumbnailsDir = path.resolve(process.cwd(), "public/thumbnails");
      server.middlewares.use(
        createThumbnailsMiddleware(thumbnailsDir, videosDir)
      );
      server.middlewares.use(createVideoStreamMiddleware(videosDir));
      server.middlewares.use(devUserStateHandler());
      server.middlewares.use(devVisitorsHandler());
      server.middlewares.use(devUploadHandler(videosDir));
      attachDriveWebSocketServer(server.httpServer, videosDir);
      server.watcher.add(videosDir);
      const reloadCatalog = (filePath) => {
        // Hidden paths (.uploads/ partial files, .DS_Store) never reach the catalog.
        const rel = filePath ? path.relative(videosDir, filePath) : "";
        if (rel.split(path.sep).some((s) => s.startsWith("."))) return;
        if (filePath && filePath.startsWith(videosDir)) {
          const mod = server.moduleGraph.getModuleById(resolvedVirtualModuleId);
          if (mod) {
            server.moduleGraph.invalidateModule(mod);
            // Not a forced full-reload: the page decides (src/lib/uploadActivity.js), so an
            // upload in progress isn't wiped by the video it just added.
            server.ws.send({ type: "custom", event: "tylertube:catalog-changed" });
          }
        }
      };
      server.watcher.on("add", reloadCatalog);
      server.watcher.on("unlink", reloadCatalog);
    },
    configurePreviewServer(server) {
      const videosDir = path.resolve(process.cwd(), "public/videos");
      const thumbnailsDir = path.resolve(process.cwd(), "public/thumbnails");
      server.middlewares.use(
        createThumbnailsMiddleware(thumbnailsDir, videosDir)
      );
      server.middlewares.use(createVideoStreamMiddleware(videosDir));
      server.middlewares.use(devUserStateHandler());
      server.middlewares.use(devVisitorsHandler());
      server.middlewares.use(devUploadHandler(videosDir));
      attachDriveWebSocketServer(server.httpServer, videosDir);
    }
  };
}
