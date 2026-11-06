// Vite plugin: virtual:video-library catalog, thumbnails at build, dev/preview middlewares.
import fs from "node:fs";
import path from "node:path";
import { generateAllThumbnails } from "../scripts/generate-thumbnails.js";
import { scanVideosDirectory } from "./catalog.js";
import { createThumbnailsMiddleware } from "./thumbnails-middleware.js";
import { createVideoStreamMiddleware } from "./stream-middleware.js";
import { attachDriveWebSocketServer } from "./drive-ws.js";

export function videoCatalogPlugin() {
  const virtualModuleId = "virtual:video-library";
  const resolvedVirtualModuleId = "\0" + virtualModuleId;

  return {
    name: "tylertube-video-catalog",
    async buildStart() {
      const videosDir = path.resolve(process.cwd(), "public/videos");
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
      attachDriveWebSocketServer(server.httpServer, videosDir);
      server.watcher.add(videosDir);
      const reloadCatalog = (filePath) => {
        if (filePath && filePath.startsWith(videosDir)) {
          const mod = server.moduleGraph.getModuleById(resolvedVirtualModuleId);
          if (mod) {
            server.moduleGraph.invalidateModule(mod);
            server.ws.send({ type: "full-reload" });
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
      attachDriveWebSocketServer(server.httpServer, videosDir);
    }
  };
}
