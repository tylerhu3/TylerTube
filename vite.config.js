import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import {
  generateAllThumbnails,
  generateThumbnailForVideo
} from "./scripts/generate-thumbnails.js";

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v"]);
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const MIME_TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".vtt": "text/vtt; charset=utf-8",
  ".srt": "text/plain; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};
const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base"
});

function encodeUrlPath(segments) {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function createThumbnailsMiddleware(thumbnailsDir, videosDir) {
  return async (req, res, next) => {
    if (!req.url || (req.method !== "GET" && req.method !== "HEAD")) {
      return next();
    }

    const [rawPathname] = req.url.split("?");
    if (!rawPathname.startsWith("/thumbnails/")) {
      return next();
    }

    const relUrl = rawPathname.slice("/thumbnails/".length);
    let decodedSegments;
    try {
      decodedSegments = relUrl
        .split("/")
        .filter(Boolean)
        .map((segment) => decodeURIComponent(segment));
    } catch {
      return next();
    }

    if (decodedSegments.length === 0) {
      return next();
    }

    const thumbPath = path.resolve(thumbnailsDir, ...decodedSegments);
    if (
      thumbPath !== thumbnailsDir &&
      !thumbPath.startsWith(thumbnailsDir + path.sep)
    ) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    let stat;
    try {
      stat = fs.statSync(thumbPath);
    } catch {
      stat = null;
    }

    // If thumbnail doesn't exist yet, try generating it on the fly from the matching video
    if (!stat || !stat.isFile() || stat.size === 0) {
      const thumbFile = decodedSegments[decodedSegments.length - 1];
      const baseName = path.basename(thumbFile, path.extname(thumbFile));
      const dirSegments = decodedSegments.slice(0, -1);
      const videoFolder = path.resolve(videosDir, ...dirSegments);

      if (
        videoFolder === videosDir ||
        videoFolder.startsWith(videosDir + path.sep)
      ) {
        for (const ext of VIDEO_EXTENSIONS) {
          const candidateVideo = path.join(videoFolder, `${baseName}${ext}`);
          if (fs.existsSync(candidateVideo)) {
            await generateThumbnailForVideo(candidateVideo, thumbPath);
            try {
              stat = fs.statSync(thumbPath);
            } catch {
              stat = null;
            }
            break;
          }
        }
      }
    }

    if (!stat || !stat.isFile()) {
      return next();
    }

    const ext = path.extname(thumbPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "image/jpeg";

    res.writeHead(200, {
      "Content-Length": stat.size,
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400"
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const stream = fs.createReadStream(thumbPath);
    req.on("close", () => stream.destroy());
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  };
}

function createVideoStreamMiddleware(videosDir) {
  return (req, res, next) => {
    if (!req.url || (req.method !== "GET" && req.method !== "HEAD")) {
      return next();
    }

    const [rawPathname, rawQuery = ""] = req.url.split("?");
    if (!rawPathname.startsWith("/videos/")) {
      return next();
    }
    const isDownload = new URLSearchParams(rawQuery).get("download") === "1";

    const relUrl = rawPathname.slice("/videos/".length);
    let decodedSegments;
    try {
      decodedSegments = relUrl
        .split("/")
        .filter(Boolean)
        .map((segment) => decodeURIComponent(segment));
    } catch {
      return next();
    }

    const filePath = path.resolve(videosDir, ...decodedSegments);
    if (
      filePath !== videosDir &&
      !filePath.startsWith(videosDir + path.sep)
    ) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return next();
    }

    if (!stat.isFile()) {
      return next();
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const fileSize = stat.size;
    const range = req.headers.range;
    const fileName = path.basename(filePath);
    const dispositionHeaders = isDownload
      ? {
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(
          fileName
        )}`
      }
      : {};

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!match) {
        res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
        res.end();
        return;
      }

      const startStr = match[1];
      const endStr = match[2];
      let start = startStr ? parseInt(startStr, 10) : 0;
      let end = endStr ? parseInt(endStr, 10) : fileSize - 1;

      if (!startStr && endStr) {
        start = Math.max(0, fileSize - parseInt(endStr, 10));
        end = fileSize - 1;
      }

      if (
        Number.isNaN(start) ||
        Number.isNaN(end) ||
        start >= fileSize ||
        start > end
      ) {
        res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
        res.end();
        return;
      }

      end = Math.min(end, fileSize - 1);
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
        ...dispositionHeaders
      });

      if (req.method === "HEAD") {
        res.end();
        return;
      }

      const stream = fs.createReadStream(filePath, { start, end });
      req.on("close", () => stream.destroy());
      stream.on("error", () => res.destroy());
      stream.pipe(res);
      return;
    }

    res.writeHead(200, {
      "Accept-Ranges": "bytes",
      "Content-Length": fileSize,
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      ...dispositionHeaders
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    req.on("close", () => stream.destroy());
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  };
}

function findMatchingSubtitle(dirEntries, videoBaseName, relDirSegments) {
  const candidates = [
    `${videoBaseName}.en.vtt`,
    `${videoBaseName}_en.vtt`,
    `${videoBaseName}.vtt`,
    `${videoBaseName}.en.srt`,
    `${videoBaseName}_en.srt`,
    `${videoBaseName}.srt`
  ];

  const entryMap = new Map(
    dirEntries.map((entry) => [entry.name.toLowerCase(), entry.name])
  );

  for (const candidate of candidates) {
    const matchedName = entryMap.get(candidate.toLowerCase());
    if (matchedName) {
      return `/videos/${encodeUrlPath([...relDirSegments, matchedName])}`;
    }
  }
  return "";
}

function findMatchingPoster(
  dirEntries,
  videoBaseName,
  relDirSegments,
  thumbnailsRoot
) {
  // 1. Check if a custom image file sits alongside the video in public/videos/
  const entryMap = new Map(
    dirEntries.map((entry) => [entry.name.toLowerCase(), entry.name])
  );
  for (const ext of IMAGE_EXTENSIONS) {
    const candidate = `${videoBaseName}${ext}`.toLowerCase();
    const matchedName = entryMap.get(candidate);
    if (matchedName) {
      return `/videos/${encodeUrlPath([...relDirSegments, matchedName])}`;
    }
  }

  // 2. Check if a custom image extension exists in public/thumbnails/
  const thumbDir = path.join(thumbnailsRoot, ...relDirSegments);
  if (fs.existsSync(thumbDir)) {
    try {
      const thumbEntries = fs.readdirSync(thumbDir);
      const thumbMap = new Map(
        thumbEntries.map((name) => [name.toLowerCase(), name])
      );
      for (const ext of IMAGE_EXTENSIONS) {
        const candidate = `${videoBaseName}${ext}`.toLowerCase();
        const matchedThumb = thumbMap.get(candidate);
        if (matchedThumb) {
          return `/thumbnails/${encodeUrlPath([
            ...relDirSegments,
            matchedThumb
          ])}`;
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  // 3. Default to generated .jpg path in /thumbnails/
  return `/thumbnails/${encodeUrlPath([
    ...relDirSegments,
    `${videoBaseName}.jpg`
  ])}`;
}

function scanVideosDirectory(videosRoot, thumbnailsRoot) {
  const results = [];
  if (!fs.existsSync(videosRoot)) {
    return results;
  }

  function walk(currentDir, relSegments = []) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => naturalCollator.compare(a.name, b.name));

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, [...relSegments, entry.name]);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!VIDEO_EXTENSIONS.has(ext)) continue;

        const baseName = path.basename(entry.name, path.extname(entry.name));
        const course = relSegments.length > 0 ? relSegments[0] : "General";
        const section =
          relSegments.length > 1 ? relSegments.slice(1).join(" / ") : "Main";
        const relPath = [...relSegments, entry.name].join("/");

        results.push({
          id: relPath,
          title: baseName,
          course,
          section,
          description:
            relSegments.length > 1 ? `${course} • ${section}` : course,
          duration: "MP4",
          src: `/videos/${encodeUrlPath([...relSegments, entry.name])}`,
          subtitleSrc: findMatchingSubtitle(entries, baseName, relSegments),
          poster: findMatchingPoster(
            entries,
            baseName,
            relSegments,
            thumbnailsRoot
          )
        });
      }
    }
  }

  walk(videosRoot, []);
  return results;
}

function videoCatalogPlugin() {
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
    }
  };
}

export default defineConfig({
  plugins: [react(), videoCatalogPlugin()],
  server: {
    port: 5173
  },
  build: {
    // Prevent Vite from duplicating large MP4 files from public/videos into dist/
    // Nginx serves /videos/ and /thumbnails/ directly from public/
    copyPublicDir: false
  }
});

