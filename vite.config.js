import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v"]);
const MIME_TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".vtt": "text/vtt; charset=utf-8",
  ".srt": "text/plain; charset=utf-8"
};
const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base"
});

function encodeUrlPath(segments) {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function createVideoStreamMiddleware(videosDir) {
  return (req, res, next) => {
    if (!req.url || (req.method !== "GET" && req.method !== "HEAD")) {
      return next();
    }

    const rawPathname = req.url.split("?")[0];
    if (!rawPathname.startsWith("/videos/")) {
      return next();
    }

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
        "Cache-Control": "no-cache"
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
      "Cache-Control": "no-cache"
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

function scanVideosDirectory(videosRoot) {
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
          poster: ""
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
    resolveId(id) {
      if (id === virtualModuleId) {
        return resolvedVirtualModuleId;
      }
    },
    load(id) {
      if (id === resolvedVirtualModuleId) {
        const videosDir = path.resolve(process.cwd(), "public/videos");
        const videos = scanVideosDirectory(videosDir);
        return `export const SCANNED_VIDEOS = ${JSON.stringify(videos)};`;
      }
    },
    configureServer(server) {
      const videosDir = path.resolve(process.cwd(), "public/videos");
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

