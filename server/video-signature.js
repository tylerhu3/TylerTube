// Fingerprint of public/videos/ (every non-hidden file's path, size and mtime), so the tunnel
// keeper (scripts/tunnel-watch.mjs) can tell when the catalog baked into dist/ is out of date.
// Includes subtitles and posters next to the videos, since the catalog picks those up too.
// Every `vite build` records the signature it was built from (server/plugin.js closeBundle).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SIGNATURE_FILE = fileURLToPath(
  new URL("../data/catalog-signature.json", import.meta.url)
);

function listFiles(dir, rel = "") {
  let entries;
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // .DS_Store, ._*, partial-download temp files
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFiles(dir, relPath));
    } else if (entry.isFile()) {
      try {
        const st = fs.statSync(path.join(dir, relPath));
        out.push(`${relPath}\0${st.size}\0${Math.floor(st.mtimeMs)}`);
      } catch {
        // vanished mid-scan
      }
    }
  }
  return out;
}

export function computeVideoSignature(videosDir) {
  const lines = listFiles(videosDir).sort();
  const hash = crypto.createHash("sha1").update(lines.join("\n")).digest("hex");
  return { signature: hash, files: lines.length };
}

export function readRecordedSignature(file = DEFAULT_SIGNATURE_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).signature || null;
  } catch {
    return null;
  }
}

export function recordSignature(signature, file = DEFAULT_SIGNATURE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ signature, builtAt: new Date().toISOString() }) + "\n");
}

// Pure rebuild decision. `seen` is { signature, since } for the latest observed signature.
// Rebuild once the folder differs from the last build and has been unchanged for stableMs
// (so a file still being copied isn't built half-written), unless that exact state already
// failed to build.
export function shouldRebuild({ current, built, seen, failed, now, stableMs }) {
  if (current === built || current === failed) return false;
  if (!seen || seen.signature !== current) return false;
  return now - seen.since >= stableMs;
}
