// Scans public/videos/ into the catalog exposed as virtual:video-library.
import fs from "node:fs";
import path from "node:path";
import {
  VIDEO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  naturalCollator,
  encodeUrlPath
} from "./shared.js";

export function findMatchingSubtitle(dirEntries, videoBaseName, relDirSegments) {
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

export function findMatchingPoster(
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

export function scanVideosDirectory(videosRoot, thumbnailsRoot) {
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
