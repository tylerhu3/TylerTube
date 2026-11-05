// GET /videos/*: byte-range video/subtitle streaming for dev and preview.
import fs from "node:fs";
import path from "node:path";
import { MIME_TYPES } from "./shared.js";

export function createVideoStreamMiddleware(videosDir) {
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
