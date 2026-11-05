// GET /thumbnails/*: serves existing thumbnails or generates them on the fly with ffmpeg.
import fs from "node:fs";
import path from "node:path";
import { generateThumbnailForVideo } from "../scripts/generate-thumbnails.js";
import { VIDEO_EXTENSIONS, MIME_TYPES } from "./shared.js";

export function createThumbnailsMiddleware(thumbnailsDir, videosDir) {
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
