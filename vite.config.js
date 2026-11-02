import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { WebSocketServer } from "ws";
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

function resolveLocalVideoFile(rawParam, videosDir) {
  const teslaPublicDir = path.resolve(process.cwd(), "tesla-video-drive/public");
  const publicDir = path.resolve(process.cwd(), "public");

  if (rawParam) {
    const cleanParam = String(rawParam).split("?")[0].trim();

    // 1. Check if it's a TylerTube /videos/... path or relative path under public/videos/
    const relFromVideos = cleanParam.startsWith("/videos/")
      ? cleanParam.slice("/videos/".length)
      : cleanParam;
    try {
      const decodedSegments = relFromVideos
        .split("/")
        .filter(Boolean)
        .map((segment) => decodeURIComponent(segment));
      if (decodedSegments.length > 0) {
        const candidateInVideos = path.resolve(videosDir, ...decodedSegments);
        if (
          (candidateInVideos === videosDir ||
            candidateInVideos.startsWith(videosDir + path.sep)) &&
          fs.existsSync(candidateInVideos) &&
          fs.statSync(candidateInVideos).isFile()
        ) {
          return candidateInVideos;
        }
      }
    } catch {
      // Ignore decode errors
    }

    // 2. Check by basename inside tesla-video-drive/public/ or public/ (e.g. testVideo.mp4)
    const baseName = path.basename(cleanParam);
    const nameCandidates = [
      baseName,
      baseName.toLowerCase().endsWith(".mp4") ? baseName : `${baseName}.mp4`
    ];
    for (const candidateName of nameCandidates) {
      for (const dir of [teslaPublicDir, publicDir, videosDir]) {
        const full = path.join(dir, candidateName);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          return full;
        }
      }
    }
  }

  // Fallback to tesla-video-drive/public/testVideo.mp4 if available
  const defaultTestVideo = path.join(teslaPublicDir, "testVideo.mp4");
  if (fs.existsSync(defaultTestVideo) && fs.statSync(defaultTestVideo).isFile()) {
    return defaultTestVideo;
  }

  return null;
}

function probeVideoDuration(filePath) {
  if (!filePath) return 0;
  try {
    const out = execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath
      ],
      { timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }
    )
      .toString()
      .trim();
    const dur = parseFloat(out);
    return Number.isFinite(dur) && dur > 0 ? dur : 0;
  } catch {
    return 0;
  }
}

function createLiveAudioMiddleware(videosDir) {
  return (req, res, next) => {
    if (!req.url || (req.method !== "GET" && req.method !== "HEAD")) {
      return next();
    }

    const [rawPathname, rawQuery = ""] = req.url.split("?");
    if (rawPathname !== "/api/live-audio") {
      return next();
    }

    const params = new URLSearchParams(rawQuery);
    const rawTarget =
      params.get("file") || params.get("channel") || "testVideo.mp4";
    const startParam = parseFloat(params.get("start") || "0");
    const startTime =
      Number.isFinite(startParam) && startParam > 0 ? startParam : 0;

    const localFile = resolveLocalVideoFile(rawTarget, videosDir);
    if (!localFile) {
      res.statusCode = 404;
      res.end("Video not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-cache, no-store",
      "Access-Control-Allow-Origin": "*"
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const ffmpegArgs = [
      "-re",
      ...(startTime > 0 ? ["-ss", String(startTime)] : []),
      "-stream_loop",
      "-1",
      "-i",
      localFile,
      "-vn",
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "64k",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-f",
      "mp3",
      "-"
    ];

    const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    ffmpeg.stdout.pipe(res);
    ffmpeg.stderr.on("data", () => {});
    ffmpeg.on("error", () => {
      try {
        res.end();
      } catch {
        // Ignore
      }
    });
    ffmpeg.on("exit", () => {
      try {
        res.end();
      } catch {
        // Ignore
      }
    });
    req.on("close", () => {
      try {
        ffmpeg.kill();
      } catch {
        // Ignore
      }
    });
  };
}

function attachDriveWebSocketServer(httpServer, videosDir) {
  if (!httpServer) return;

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: true
  });

  httpServer.on("upgrade", (req, socket, head) => {
    if (!req.url) return;
    const [rawPathname] = req.url.split("?");
    if (rawPathname !== "/ws/mpeg1") {
      // Leave other WebSocket upgrades (such as Vite HMR) untouched
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    const [, rawQuery = ""] = (req.url || "").split("?");
    const params = new URLSearchParams(rawQuery);
    const rawTarget =
      params.get("file") ||
      params.get("channel") ||
      params.get("url") ||
      "testVideo.mp4";
    const initialQuality = parseInt(params.get("quality") || "720", 10) || 720;
    const initialSeek =
      parseFloat(params.get("seek") || params.get("start") || "0") || 0;
    const initialSpeed = parseFloat(params.get("speed") || "1") || 1;
    const initialLoop =
      params.get("loop") === "1" || params.get("loop") === "true";

    const qualMap = {
      360: "640:360",
      480: "854:480",
      720: "1280:720",
      1080: "1920:1080"
    };
    let currentQuality = qualMap[initialQuality] ? initialQuality : 720;
    let currentSpeed = Math.max(0.25, Math.min(2.0, initialSpeed));
    let currentSeek = Math.max(0, initialSeek);
    let loopEnabled = Boolean(initialLoop);
    let isPaused = false;
    let activeFfmpeg = null;
    let pauseHoldTimer = null;
    let drainInterval = null;
    let wsClosed = false;

    const localFile = resolveLocalVideoFile(rawTarget, videosDir);
    if (!localFile) {
      try {
        ws.send(
          JSON.stringify({ type: "error", message: "Video file not found" })
        );
        ws.close();
      } catch {
        // Ignore
      }
      return;
    }

    const duration = probeVideoDuration(localFile);
    if (duration > 0 && currentSeek >= duration - 0.5) {
      currentSeek = 0;
    }

    function sendJson(payload) {
      if (!wsClosed && ws.readyState === 1) {
        try {
          ws.send(JSON.stringify(payload));
        } catch {
          // Ignore send errors
        }
      }
    }

    function killActiveFfmpeg() {
      if (drainInterval) {
        clearInterval(drainInterval);
        drainInterval = null;
      }
      if (pauseHoldTimer) {
        clearTimeout(pauseHoldTimer);
        pauseHoldTimer = null;
      }
      if (activeFfmpeg) {
        const proc = activeFfmpeg;
        activeFfmpeg = null;
        try {
          proc.stdout.removeAllListeners("data");
        } catch {
          // Ignore
        }
        try {
          proc.removeAllListeners("close");
        } catch {
          // Ignore
        }
        try {
          proc.kill("SIGKILL");
        } catch {
          // Ignore
        }
      }
    }

    sendJson({
      type: "meta",
      isLive: false,
      duration,
      seekTime: currentSeek,
      speed: currentSpeed,
      quality: currentQuality,
      loop: loopEnabled
    });

    function doStream(streamUrl, isReset) {
      killActiveFfmpeg();
      if (wsClosed) return;

      const scale = qualMap[currentQuality] || "1280:720";
      const bitrate = scale.endsWith("360")
        ? "600k"
        : scale.endsWith("480")
          ? "900k"
          : scale.endsWith("720")
            ? "1600k"
            : "2600k";
      const spd = currentSpeed;

      if (isReset) {
        sendJson({
          type: "reset",
          seekTime: currentSeek,
          duration,
          speed: spd,
          quality: currentQuality,
          paused: isPaused,
          loop: loopEnabled
        });
      } else {
        sendJson({ type: "status", message: "Starting MPEG1 stream..." });
      }

      try {
        const inputArgs = [];
        if (currentSeek > 0) {
          inputArgs.push("-ss", currentSeek.toFixed(3));
        }
        // Buffer-ahead readrate: transcode at up to 1.6x playback speed so the client
        // can build a healthy jitter buffer against spotty or high-latency connections.
        // Initial burst: 10s of audio/video for instant startup headroom.
        const burstReadRate = Math.min(2.5, Math.max(1.3, (parseFloat(spd) || 1.0) * 1.5));
        inputArgs.push(
          "-readrate",
          String(burstReadRate),
          "-readrate_initial_burst",
          "10.0",
          "-fflags",
          "+genpts",
          "-i",
          streamUrl
        );

        const vfParts = [];
        if (Math.abs(spd - 1.0) > 0.01) {
          vfParts.push(`setpts=PTS/${spd}`);
        }
        vfParts.push("fps=30", `scale=${scale}`);

        const afParts = [];
        if (Math.abs(spd - 1.0) > 0.01) {
          afParts.push(`atempo=${spd}`);
        }
        afParts.push("aresample=async=1");

        const ffmpeg = spawn(
          "ffmpeg",
          [
            ...inputArgs,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c:v",
            "mpeg1video",
            "-q:v",
            "5",
            "-b:v",
            bitrate,
            "-bf",
            "0",
            "-vf",
            vfParts.join(","),
            "-c:a",
            "mp2",
            "-b:a",
            "128k",
            "-ar",
            "44100",
            "-ac",
            "2",
            "-af",
            afParts.join(","),
            "-pes_payload_size",
            "0",
            "-f",
            "mpegts",
            "-muxdelay",
            "0.001",
            "-muxpreload",
            "0",
            "-"
          ],
          { stdio: ["ignore", "pipe", "pipe"] }
        );

        activeFfmpeg = ffmpeg;
        let bytesSentSinceSpawn = 0;
        const MAX_WS_BUFFER = 2 * 1024 * 1024; // 2MB backpressure limit
        let isStdoutPaused = false;

        ffmpeg.stdout.on("data", (chunk) => {
          if (wsClosed || activeFfmpeg !== ffmpeg) return;
          if (ws.readyState === 1) {
            ws.send(chunk);
            bytesSentSinceSpawn += chunk.length;

            // WebSocket backpressure: pause ffmpeg if client connection cannot keep up
            if (ws.bufferedAmount > MAX_WS_BUFFER && !isStdoutPaused) {
              isStdoutPaused = true;
              try {
                ffmpeg.stdout.pause();
              } catch {
                // Ignore
              }
            }

            // If seeking while paused, allow enough packets for 1 decoded preview frame then SIGSTOP
            if (
              isPaused &&
              bytesSentSinceSpawn >= 96 * 1024 &&
              !pauseHoldTimer
            ) {
              pauseHoldTimer = setTimeout(() => {
                pauseHoldTimer = null;
                if (isPaused && activeFfmpeg === ffmpeg) {
                  try {
                    ffmpeg.kill("SIGSTOP");
                  } catch {
                    // Ignore
                  }
                }
              }, 30);
            }
          }
        });

        drainInterval = setInterval(() => {
          if (wsClosed || activeFfmpeg !== ffmpeg) {
            if (drainInterval) clearInterval(drainInterval);
            drainInterval = null;
            return;
          }
          if (isStdoutPaused && ws.bufferedAmount < 512 * 1024) {
            isStdoutPaused = false;
            try {
              ffmpeg.stdout.resume();
            } catch {
              // Ignore
            }
          }
        }, 50);

        ffmpeg.stderr.on("data", () => {});

        ffmpeg.on("close", (code) => {
          if (drainInterval) {
            clearInterval(drainInterval);
            drainInterval = null;
          }
          if (wsClosed || activeFfmpeg !== ffmpeg) return;
          activeFfmpeg = null;
          if (code === 0) {
            if (loopEnabled) {
              currentSeek = 0;
              doStream(streamUrl, true);
            } else {
              currentSeek = duration > 0 ? duration : 0;
              isPaused = true;
              sendJson({ type: "ended", duration });
            }
            return;
          }
          if (code !== 0 && code !== null) {
            sendJson({
              type: "status",
              message: `Stream ended (code ${code})`
            });
          }
          try {
            ws.close();
          } catch {
            // Ignore
          }
        });

        ffmpeg.on("error", (err) => {
          if (wsClosed || activeFfmpeg !== ffmpeg) return;
          sendJson({
            type: "error",
            message: (err?.message || "ffmpeg error").slice(0, 100)
          });
        });
      } catch (err) {
        sendJson({
          type: "error",
          message: (err?.message || "spawn error").slice(0, 100)
        });
        try {
          ws.close();
        } catch {
          // Ignore
        }
      }
    }

    doStream(localFile, false);

    ws.on("message", (raw) => {
      if (wsClosed) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || !msg.type) return;

      if (msg.type === "pause") {
        isPaused = true;
        if (pauseHoldTimer) {
          clearTimeout(pauseHoldTimer);
          pauseHoldTimer = null;
        }
        if (activeFfmpeg) {
          try {
            activeFfmpeg.kill("SIGSTOP");
          } catch {
            // Ignore
          }
        }
      } else if (msg.type === "resume") {
        isPaused = false;
        if (pauseHoldTimer) {
          clearTimeout(pauseHoldTimer);
          pauseHoldTimer = null;
        }
        if (activeFfmpeg) {
          try {
            activeFfmpeg.kill("SIGCONT");
          } catch {
            // Ignore
          }
        } else {
          if (duration > 0 && currentSeek >= duration - 0.5) {
            currentSeek = 0;
          }
          doStream(localFile, true);
        }
      } else if (msg.type === "seek") {
        let target = parseFloat(msg.time);
        if (!Number.isFinite(target)) return;
        if (duration > 0) {
          target = Math.max(0, Math.min(duration - 0.1, target));
        } else {
          target = Math.max(0, target);
        }
        currentSeek = target;
        doStream(localFile, true);
      } else if (msg.type === "speed") {
        const spd = parseFloat(msg.speed);
        if (!Number.isFinite(spd)) return;
        currentSpeed = Math.max(0.25, Math.min(2.0, spd));
        if (Number.isFinite(msg.currentTime)) {
          currentSeek =
            duration > 0
              ? Math.max(0, Math.min(duration - 0.1, parseFloat(msg.currentTime)))
              : Math.max(0, parseFloat(msg.currentTime));
        }
        doStream(localFile, true);
      } else if (msg.type === "quality") {
        const q = parseInt(msg.quality, 10);
        if (!qualMap[q]) return;
        currentQuality = q;
        if (Number.isFinite(msg.currentTime)) {
          currentSeek =
            duration > 0
              ? Math.max(0, Math.min(duration - 0.1, parseFloat(msg.currentTime)))
              : Math.max(0, parseFloat(msg.currentTime));
        }
        doStream(localFile, true);
      } else if (msg.type === "loop") {
        loopEnabled = Boolean(msg.loop);
      }
    });

    ws.on("close", () => {
      wsClosed = true;
      killActiveFfmpeg();
    });

    ws.on("error", () => {
      wsClosed = true;
      killActiveFfmpeg();
    });
  });
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
    closeBundle() {
      // Ensure icons and standalone assets are copied to dist/ even with copyPublicDir: false
      const distDir = path.resolve(process.cwd(), "dist");
      if (!fs.existsSync(distDir)) return;

      const assetsToCopy = [
        "jsmpeg.min.js",
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
      server.middlewares.use(createLiveAudioMiddleware(videosDir));
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
      server.middlewares.use(createLiveAudioMiddleware(videosDir));
      attachDriveWebSocketServer(server.httpServer, videosDir);
    }
  };
}

export default defineConfig({
  plugins: [react(), videoCatalogPlugin()],
  server: {
    port: 5173,
    host: true
  },
  build: {
    // Prevent Vite from duplicating large MP4 files from public/videos into dist/
    // Nginx serves /videos/ and /thumbnails/ directly from public/
    copyPublicDir: false
  }
});

