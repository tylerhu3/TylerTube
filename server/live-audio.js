// GET /api/live-audio?file=&start=: ffmpeg-transcoded MP3 audio stream.
import { spawn } from "node:child_process";
import { resolveLocalVideoFile } from "./media-files.js";

export function createLiveAudioMiddleware(videosDir) {
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
      params.get("file") || params.get("channel") || "";
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
