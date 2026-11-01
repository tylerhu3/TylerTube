import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v"]);

function collectVideos(videosRoot) {
  const videos = [];
  if (!fs.existsSync(videosRoot)) return videos;

  function walk(currentDir, relSegments = []) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, [...relSegments, entry.name]);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!VIDEO_EXTENSIONS.has(ext)) continue;
        const baseName = path.basename(entry.name, path.extname(entry.name));
        videos.push({
          videoPath: fullPath,
          relSegments,
          baseName
        });
      }
    }
  }

  walk(videosRoot, []);
  return videos;
}

export async function generateThumbnailForVideo(videoPath, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const timestamps = ["00:00:05", "00:00:01", "00:00:00"];
  for (const ss of timestamps) {
    try {
      await execFileAsync("ffmpeg", [
        "-y",
        "-ss",
        ss,
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-vf",
        "scale=480:-2",
        "-q:v",
        "4",
        "-update",
        "1",
        outputPath
      ]);
      const stat = fs.statSync(outputPath);
      if (stat.size > 0) {
        return true;
      }
    } catch {
      // Try earlier timestamp fallback
    }
  }
  return false;
}

export async function generateAllThumbnails({
  videosRoot = path.resolve(process.cwd(), "public/videos"),
  thumbnailsRoot = path.resolve(process.cwd(), "public/thumbnails"),
  concurrency = Math.min(8, Math.max(2, os.cpus().length))
} = {}) {
  const videos = collectVideos(videosRoot);
  const pending = [];

  for (const item of videos) {
    const outPath = path.join(
      thumbnailsRoot,
      ...item.relSegments,
      `${item.baseName}.jpg`
    );
    try {
      const stat = fs.statSync(outPath);
      if (stat.isFile() && stat.size > 0) {
        continue;
      }
    } catch {
      // Needs generation
    }
    pending.push({ ...item, outPath });
  }

  if (pending.length === 0) {
    console.log(
      `[thumbnails] All ${videos.length} video thumbnails are up to date.`
    );
    return { total: videos.length, generated: 0 };
  }

  console.log(
    `[thumbnails] Generating ${pending.length} missing thumbnails (${concurrency} workers)...`
  );

  let index = 0;
  let generated = 0;

  async function worker() {
    while (index < pending.length) {
      const current = pending[index++];
      const ok = await generateThumbnailForVideo(
        current.videoPath,
        current.outPath
      );
      if (ok) generated++;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) }, () =>
      worker()
    )
  );

  console.log(
    `[thumbnails] Done! Generated ${generated}/${pending.length} thumbnails.`
  );
  return { total: videos.length, generated };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateAllThumbnails().catch((err) => {
    console.error("[thumbnails] Error generating thumbnails:", err);
    process.exitCode = 1;
  });
}

