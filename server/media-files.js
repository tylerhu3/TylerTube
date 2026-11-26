// Resolves client-supplied video paths safely and probes durations.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const binaryCache = new Map();

// Resolves ffmpeg / ffprobe even when the host process inherited a stale PATH
// (e.g. Windows terminals/services opened before WinGet/Scoop/Chocolatey installed them,
// or macOS LaunchAgents with a minimal PATH).
export function findMediaBinary(
  name,
  { env = process.env, platform = process.platform, existsSync = fs.existsSync } = {}
) {
  const useCache = env === process.env && platform === process.platform && existsSync === fs.existsSync;
  if (useCache && binaryCache.has(name)) return binaryCache.get(name);

  const envKey = `${name.toUpperCase()}_PATH`;
  if (env[envKey] && existsSync(env[envKey])) {
    if (useCache) binaryCache.set(name, env[envKey]);
    return env[envKey];
  }

  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const exe = platform === "win32" && !name.toLowerCase().endsWith(".exe") ? `${name}.exe` : name;
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path");
  const pathDirs = (pathKey ? env[pathKey] || "" : "")
    .split(platform === "win32" ? ";" : ":")
    .map((dir) => dir.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);

  for (const dir of pathDirs) {
    const candidate = pathApi.join(dir, exe);
    if (existsSync(candidate)) {
      if (useCache) binaryCache.set(name, candidate);
      return candidate;
    }
  }

  const fallbacks =
    platform === "win32"
      ? [
          env.LOCALAPPDATA ? pathApi.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", exe) : "",
          env.USERPROFILE ? pathApi.join(env.USERPROFILE, "scoop", "shims", exe) : "",
          pathApi.join("C:\\ProgramData\\chocolatey\\bin", exe),
          pathApi.join("C:\\ffmpeg\\bin", exe)
        ]
      : [`/opt/homebrew/bin/${exe}`, `/usr/local/bin/${exe}`, `/usr/bin/${exe}`];

  for (const candidate of fallbacks) {
    if (candidate && existsSync(candidate)) {
      if (useCache) binaryCache.set(name, candidate);
      return candidate;
    }
  }

  return name;
}

export function findFfmpegBinary(opts) {
  return findMediaBinary("ffmpeg", opts);
}

export function findFfprobeBinary(opts) {
  return findMediaBinary("ffprobe", opts);
}

export function resetCachedMediaBinaries() {
  binaryCache.clear();
}

export function resolveLocalVideoFile(rawParam, videosDir) {
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

    // 2. Check by basename inside public/ or public/videos/
    const baseName = path.basename(cleanParam);
    const nameCandidates = [
      baseName,
      baseName.toLowerCase().endsWith(".mp4") ? baseName : `${baseName}.mp4`
    ];
    for (const candidateName of nameCandidates) {
      for (const dir of [publicDir, videosDir]) {
        const full = path.join(dir, candidateName);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          return full;
        }
      }
    }
  }

  return null;
}

export function probeVideoDuration(filePath) {
  if (!filePath) return 0;
  try {
    const out = execFileSync(
      findFfprobeBinary(),
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

// True if the file has at least one audio stream (WebCodecs mode adds a PCM output only then).
export function probeHasAudioStream(filePath) {
  if (!filePath) return false;
  try {
    const out = execFileSync(
      findFfprobeBinary(),
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=index",
        "-of",
        "csv=p=0",
        filePath
      ],
      { timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }
    )
      .toString()
      .trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

// Source video frame rate as the raw ffprobe pair { avg, r } (e.g. "30000/1001"); parse with
// pickSourceFps() in webcodecs-stream.js. Empty strings when probing fails.
export function probeVideoFrameRate(filePath) {
  if (!filePath) return { avg: "", r: "" };
  try {
    const out = execFileSync(
      findFfprobeBinary(),
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=avg_frame_rate,r_frame_rate",
        "-of",
        "json",
        filePath
      ],
      { timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }
    ).toString();
    const stream = JSON.parse(out)?.streams?.[0] || {};
    return { avg: String(stream.avg_frame_rate || ""), r: String(stream.r_frame_rate || "") };
  } catch {
    return { avg: "", r: "" };
  }
}
