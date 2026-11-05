// Fast unit tests for server/ (no Vite, no ffmpeg). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeUrlPath } from "../server/shared.js";
import { scanVideosDirectory, findMatchingSubtitle } from "../server/catalog.js";
import { resolveLocalVideoFile } from "../server/media-files.js";

function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tylertube-"));
  for (const rel of files) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "");
  }
  return root;
}

test("encodeUrlPath encodes each segment, keeps slashes", () => {
  assert.equal(encodeUrlPath(["My Course", "a#b&c.mp4"]), "My%20Course/a%23b%26c.mp4");
});

test("findMatchingSubtitle prefers .en.vtt and is case-insensitive", () => {
  const entries = ["Lesson.SRT", "lesson.en.vtt"].map((name) => ({ name }));
  assert.equal(findMatchingSubtitle(entries, "lesson", ["C"]), "/videos/C/lesson.en.vtt");
  assert.equal(findMatchingSubtitle([{ name: "Lesson.SRT" }], "lesson", []), "/videos/Lesson.SRT");
  assert.equal(findMatchingSubtitle([], "lesson", []), "");
});

test("scanVideosDirectory: course/section grouping, natural sort, posters, subtitles", () => {
  const videos = makeTree([
    "root.mp4",
    "Course A/10. Ten.mp4",
    "Course A/2. Two.mp4",
    "Course A/2. Two.srt",
    "Course A/Part 1/Sub/clip.webm",
    "Course A/Part 1/Sub/clip.png",
    "Course A/notes.txt",
    ".hidden/skip.mp4"
  ]);
  const thumbs = makeTree([]);
  const list = scanVideosDirectory(videos, thumbs);
  assert.deepEqual(list.map((v) => v.id), [
    "Course A/2. Two.mp4",
    "Course A/10. Ten.mp4",
    "Course A/Part 1/Sub/clip.webm",
    "root.mp4"
  ]);
  const byId = Object.fromEntries(list.map((v) => [v.id, v]));
  assert.equal(byId["root.mp4"].course, "General");
  assert.equal(byId["root.mp4"].section, "Main");
  assert.equal(byId["Course A/Part 1/Sub/clip.webm"].section, "Part 1 / Sub");
  assert.equal(byId["Course A/Part 1/Sub/clip.webm"].poster, "/videos/Course%20A/Part%201/Sub/clip.png");
  assert.equal(byId["Course A/2. Two.mp4"].subtitleSrc, "/videos/Course%20A/2.%20Two.srt");
  assert.equal(byId["Course A/10. Ten.mp4"].poster, "/thumbnails/Course%20A/10.%20Ten.jpg");
  assert.deepEqual(scanVideosDirectory(path.join(videos, "missing"), thumbs), []);
});

test("resolveLocalVideoFile resolves /videos/ paths (URL-encoded)", () => {
  const videos = makeTree(["My Course/a b.mp4"]);
  assert.equal(
    resolveLocalVideoFile("/videos/My%20Course/a%20b.mp4", videos),
    path.join(videos, "My Course", "a b.mp4")
  );
  assert.equal(resolveLocalVideoFile("/videos/My%20Course/missing.mp4", videos), null);
  assert.equal(resolveLocalVideoFile("", videos), null);
});

test("resolveLocalVideoFile blocks path traversal", () => {
  const base = makeTree(["videos/ok.mp4", "secret.mp4", "secret.txt"]);
  const videos = path.join(base, "videos");
  for (const p of [
    "/videos/../secret.txt",
    "../secret.txt",
    "%2e%2e/secret.txt",
    "/videos/%2e%2e/secret.txt",
    path.join(base, "secret.txt")
  ]) {
    const r = resolveLocalVideoFile(p, videos);
    assert.ok(r === null || r.startsWith(videos + path.sep), `${p} escaped: ${r}`);
  }
});
