// Resolves client-supplied video paths safely and probes durations.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

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

// True if the file has at least one audio stream (WebCodecs mode adds a PCM output only then).
export function probeHasAudioStream(filePath) {
  if (!filePath) return false;
  try {
    const out = execFileSync(
      "ffprobe",
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
