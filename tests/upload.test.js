// Uploads: pure rules (server/upload-rules.js), the disk store (server/upload-store.js) and the
// HTTP routes on the standalone server (server/upload.js, server/standalone.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  UploadError,
  checkChunk,
  classifyFile,
  evaluateProbe,
  parseFolderPath,
  parseUploadRoute,
  resolveInside,
  suggestFreeName,
  validateName
} from "../server/upload-rules.js";
import { createUploadStore } from "../server/upload-store.js";
import { startDriveServer } from "../server/standalone.js";
import { ipBucket } from "../server/upload.js";

const GB = 1024 ** 3;
const KEY = "test-upload-key-123";

function tmpLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tylertube-upload-"));
  fs.mkdirSync(path.join(dir, "Course", "Section"), { recursive: true });
  return dir;
}

const goodProbe = async () => ({
  streams: [{ codec_type: "video", codec_name: "h264" }, { codec_type: "audio", codec_name: "aac" }],
  format: { duration: "12.5" }
});

function makeStore(dir, opts = {}) {
  return createUploadStore({
    videosDir: dir,
    probe: goodProbe,
    freeBytes: () => 100 * GB,
    log: () => {},
    ...opts
  });
}

const code = (c) => (err) => err instanceof UploadError && err.code === c;

// --- rules ----------------------------------------------------------------------------------

test("validateName accepts normal names and rejects dangerous ones", () => {
  assert.equal(validateName("  Lesson 1.mp4 "), "Lesson 1.mp4");
  assert.equal(validateName("Café.mp4"), "Café.mp4".normalize("NFC"));
  for (const bad of ["", " ", ".", "..", ".hidden", "a/b", "a\\b", "a:b", "x\u0000y", "x\ny", "a".repeat(201), 42]) {
    assert.throws(() => validateName(bad), code("INVALID_NAME"), JSON.stringify(bad));
  }
});

test("parseFolderPath splits, validates and limits depth", () => {
  assert.deepEqual(parseFolderPath(""), []);
  assert.deepEqual(parseFolderPath(undefined), []);
  assert.deepEqual(parseFolderPath("/Course//Section/"), ["Course", "Section"]);
  assert.throws(() => parseFolderPath("a/b/c/d"), code("INVALID_FOLDER"));
  assert.throws(() => parseFolderPath("Course/../.."), code("INVALID_NAME"));
  assert.throws(() => parseFolderPath("Course/.secret"), code("INVALID_NAME"));
});

test("classifyFile by extension", () => {
  assert.equal(classifyFile("a.MP4"), "video");
  assert.equal(classifyFile("a.webm"), "video");
  assert.equal(classifyFile("a.en.vtt"), "subtitle");
  assert.equal(classifyFile("a.jpg"), "image");
  assert.throws(() => classifyFile("a.exe"), code("UNSUPPORTED_TYPE"));
  assert.throws(() => classifyFile("noext"), code("UNSUPPORTED_TYPE"));
});

test("resolveInside refuses to leave the root", () => {
  assert.equal(resolveInside("/lib", ["a", "b"]), path.resolve("/lib/a/b"));
  assert.throws(() => resolveInside("/lib", [".."]), code("INVALID_FOLDER"));
  assert.throws(() => resolveInside("/lib", ["../lib2"]), code("INVALID_FOLDER"));
});

test("suggestFreeName counts up past taken names", () => {
  const taken = new Set(["Clip (2).mp4"]);
  assert.equal(suggestFreeName("Clip.mp4", (n) => taken.has(n)), "Clip (3).mp4");
  assert.equal(suggestFreeName("Clip (2).mp4", () => false), "Clip (2).mp4");
});

test("checkChunk enforces offset, size and bounds", () => {
  checkChunk({ offset: 0, current: 0, size: 10, length: 10 });
  assert.throws(() => checkChunk({ offset: 5, current: 0, size: 10, length: 1 }), (e) => e.code === "OFFSET_MISMATCH" && e.extra.offset === 0);
  assert.throws(() => checkChunk({ offset: NaN, current: 0, size: 10, length: 1 }), code("INVALID_OFFSET"));
  assert.throws(() => checkChunk({ offset: 0, current: 0, size: 10, length: 11 }), code("CHUNK_PAST_END"));
  assert.throws(() => checkChunk({ offset: 0, current: 0, size: 10, length: 0 }), code("EMPTY_CHUNK"));
  assert.throws(() => checkChunk({ offset: 0, current: 0, size: 1e9, length: 17 * 1024 * 1024 }), code("CHUNK_TOO_LARGE"));
});

test("evaluateProbe accepts videos, warns on non-H.264, rejects non-videos", () => {
  assert.deepEqual(
    evaluateProbe({ streams: [{ codec_type: "video", codec_name: "h264" }], format: { duration: "3" } }, ".mp4"),
    { ok: true, warning: undefined, duration: 3 }
  );
  const hevc = evaluateProbe({ streams: [{ codec_type: "video", codec_name: "hevc" }], format: { duration: "3" } }, ".mp4");
  assert.equal(hevc.ok, true);
  assert.match(hevc.warning, /hevc/);
  assert.equal(evaluateProbe({ streams: [{ codec_type: "audio" }], format: { duration: "3" } }, ".mp4").ok, false);
  assert.equal(evaluateProbe({ streams: [{ codec_type: "video", codec_name: "h264" }], format: {} }, ".mp4").ok, false);
  // A cover image alone isn't a video.
  assert.equal(
    evaluateProbe({ streams: [{ codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } }], format: { duration: "3" } }, ".mp4").ok,
    false
  );
});

test("ipBucket groups IPv6 by /64", () => {
  assert.equal(ipBucket("1.2.3.4"), "1.2.3.4");
  assert.equal(ipBucket("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(ipBucket("2001:db8:1:2:bbbb:cccc:dddd:eeee"), "2001:db8:1:2::/64");
  assert.equal(ipBucket("::1"), "::1");
});

test("parseUploadRoute", () => {
  assert.equal(parseUploadRoute("/api/state"), null);
  assert.deepEqual(parseUploadRoute("/api/upload"), { action: "sessions" });
  assert.deepEqual(parseUploadRoute("/api/upload/folders"), { action: "folders" });
  const id = "a".repeat(32);
  assert.deepEqual(parseUploadRoute(`/api/upload/session/${id}`), { action: "session", id });
  assert.deepEqual(parseUploadRoute(`/api/upload/session/${id}/complete`), { action: "complete", id });
  assert.deepEqual(parseUploadRoute("/api/upload/session/../../x"), { action: "unknown" });
});

// --- store ----------------------------------------------------------------------------------

test("store: folders are listed (hidden skipped) and created safely", () => {
  const dir = tmpLibrary();
  fs.mkdirSync(path.join(dir, ".uploads"));
  fs.writeFileSync(path.join(dir, "Course", "video.mp4"), "x");
  const store = makeStore(dir);
  assert.deepEqual(store.listFolders(), ["Course", "Course/Section"]);
  assert.deepEqual(store.createFolder("New Course/Part 1"), { path: "New Course/Part 1", created: true });
  assert.deepEqual(store.createFolder("Course"), { path: "Course", created: false });
  assert.throws(() => store.createFolder("Course/video.mp4"), code("NOT_A_FOLDER"));
  assert.throws(() => store.createFolder(""), code("INVALID_FOLDER"));

  // A symlink pointing outside the library can't be used as a parent.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tylertube-outside-"));
  fs.symlinkSync(outside, path.join(dir, "Escape"));
  assert.throws(() => store.createFolder("Escape/inner"), code("INVALID_FOLDER"));
  assert.equal(fs.existsSync(path.join(outside, "inner")), false);
  assert.throws(() => store.createSession({ folder: "Escape", name: "a.mp4", size: 1 }), code("INVALID_FOLDER"));
});

test("store: full upload, resume, and no-overwrite finish", async () => {
  const dir = tmpLibrary();
  const store = makeStore(dir);
  const data = Buffer.from("0123456789abcdef");

  const s = store.createSession({ folder: "Course/Section", name: "Lesson.mp4", size: data.length });
  assert.equal(s.offset, 0);
  assert.equal(s.resumed, false);
  assert.ok(fs.existsSync(path.join(dir, ".uploads", `${s.id}.part`)));

  assert.deepEqual(await store.writeChunk(s.id, 0, Readable.from([data.subarray(0, 10)]), 10), { offset: 10, size: 16 });

  // Same folder + name + size → the same session, resumed.
  const again = store.createSession({ folder: "Course/Section", name: "Lesson.mp4", size: data.length });
  assert.equal(again.id, s.id);
  assert.equal(again.offset, 10);
  assert.equal(again.resumed, true);

  await assert.rejects(store.writeChunk(s.id, 0, Readable.from([data]), 16), code("OFFSET_MISMATCH"));
  await assert.rejects(store.complete(s.id), code("INCOMPLETE"));
  await store.writeChunk(s.id, 10, Readable.from([data.subarray(10)]), 6);

  // Someone else created the target meanwhile: refuse, keep the upload, suggest a name.
  const target = path.join(dir, "Course", "Section", "Lesson.mp4");
  fs.writeFileSync(target, "original");
  await assert.rejects(store.complete(s.id), (e) => e.code === "NAME_TAKEN" && e.extra.suggestion === "Lesson (2).mp4");
  assert.equal(fs.readFileSync(target, "utf8"), "original");

  const result = await store.complete(s.id, { name: "Lesson (2).mp4" });
  assert.equal(result.path, "Course/Section/Lesson (2).mp4");
  assert.equal(result.url, "/videos/Course/Section/Lesson%20(2).mp4");
  assert.deepEqual(fs.readFileSync(path.join(dir, "Course", "Section", "Lesson (2).mp4")), data);
  // Only the small "finished" record is left (for retried completes).
  assert.deepEqual(fs.readdirSync(path.join(dir, ".uploads")), [`${s.id}.done.json`]);
  assert.equal(store.getSession(s.id).done, true);
});

test("store: a different file with the same name only replaces an idle session", async () => {
  const dir = tmpLibrary();
  let t = 1_000_000;
  const store = makeStore(dir, { now: () => t });
  const a = store.createSession({ folder: "", name: "a.mp4", size: 4, lastModified: 1000 });
  await store.writeChunk(a.id, 0, Readable.from([Buffer.from("ab")]), 2);
  const same = store.createSession({ folder: "", name: "a.mp4", size: 4, lastModified: 1000 });
  assert.equal(same.id, a.id);
  assert.equal(same.offset, 2);
  // Another device is actively uploading a different "a.mp4": don't wipe it.
  assert.throws(() => store.createSession({ folder: "", name: "a.mp4", size: 4, lastModified: 2000 }), code("BUSY"));
  t += 6 * 60 * 1000;
  const other = store.createSession({ folder: "", name: "a.mp4", size: 4, lastModified: 2000 });
  assert.notEqual(other.id, a.id);
  assert.equal(other.offset, 0);
  assert.throws(() => store.getSession(a.id), code("SESSION_NOT_FOUND"));
});

test("store: complete is idempotent after a lost reply", async () => {
  const dir = tmpLibrary();
  const store = makeStore(dir);
  const s = store.createSession({ folder: "Course", name: "a.mp4", size: 3 });
  await store.writeChunk(s.id, 0, Readable.from([Buffer.from("abc")]), 3);
  const first = await store.complete(s.id);
  assert.deepEqual(await store.complete(s.id), first);
  assert.deepEqual(store.getSession(s.id), { id: s.id, offset: 3, size: 3, done: true, result: first });
  await assert.rejects(store.writeChunk(s.id, 0, Readable.from([Buffer.from("abc")]), 3), (e) => e.code === "ALREADY_COMPLETE" && e.extra.result.path === "Course/a.mp4");
});

test("store: abandoned sessions stop reserving disk space", async () => {
  const dir = tmpLibrary();
  let t = 1_000_000;
  const store = makeStore(dir, { now: () => t, freeBytes: () => 10 * GB, reserveBytes: 5 * GB });
  store.createSession({ folder: "", name: "big.mp4", size: 4 * GB });
  assert.throws(() => store.createSession({ folder: "", name: "b.mp4", size: 2 * GB }), code("DISK_FULL"));
  t += 31 * 60 * 1000;
  assert.equal(store.createSession({ folder: "", name: "b.mp4", size: 2 * GB }).offset, 0);
});

test("store: rename must keep the file type", async () => {
  const dir = tmpLibrary();
  const store = makeStore(dir);
  const s = store.createSession({ folder: "", name: "a.mp4", size: 1 });
  await store.writeChunk(s.id, 0, Readable.from([Buffer.from("x")]), 1);
  await assert.rejects(store.complete(s.id, { name: "a.vtt" }), code("INVALID_NAME"));
});

test("store: existing target is refused up front with a suggestion", () => {
  const dir = tmpLibrary();
  fs.writeFileSync(path.join(dir, "Course", "Intro.mp4"), "x");
  const store = makeStore(dir);
  assert.throws(
    () => store.createSession({ folder: "Course", name: "Intro.mp4", size: 5 }),
    (e) => e.code === "NAME_TAKEN" && e.extra.suggestion === "Intro (2).mp4"
  );
  assert.throws(() => store.createSession({ folder: "Nope", name: "a.mp4", size: 5 }), code("FOLDER_NOT_FOUND"));
  assert.throws(() => store.createSession({ folder: "Course", name: "a.exe", size: 5 }), code("UNSUPPORTED_TYPE"));
  assert.throws(() => store.createSession({ folder: "Course", name: "a.mp4", size: 0 }), code("INVALID_SIZE"));
});

test("store: disk-space guard keeps the reserve free", async () => {
  const dir = tmpLibrary();
  let free = 10 * GB;
  const store = makeStore(dir, { freeBytes: () => free, reserveBytes: 5 * GB });
  assert.throws(() => store.createSession({ folder: "", name: "big.mp4", size: 6 * GB }), (e) => e.code === "DISK_FULL" && e.status === 507);
  const s = store.createSession({ folder: "", name: "ok.mp4", size: 4 * GB });
  // Pending bytes of unfinished uploads count against new ones.
  assert.throws(() => store.createSession({ folder: "", name: "second.mp4", size: 2 * GB }), code("DISK_FULL"));
  free = 5 * GB;
  await assert.rejects(store.writeChunk(s.id, 0, Readable.from([Buffer.from("x")]), 1), code("DISK_FULL"));
});

test("store: an interrupted or oversized chunk is rolled back", async () => {
  const dir = tmpLibrary();
  const store = makeStore(dir);
  const s = store.createSession({ folder: "", name: "a.mp4", size: 20 });
  await store.writeChunk(s.id, 0, Readable.from([Buffer.from("12345")]), 5);

  // Body shorter than Content-Length (connection dropped).
  await assert.rejects(store.writeChunk(s.id, 5, Readable.from([Buffer.from("67")]), 5), code("INCOMPLETE_CHUNK"));
  assert.equal(store.getSession(s.id).offset, 5);

  // Stream error mid-chunk.
  const broken = new Readable({
    read() {
      this.push(Buffer.from("67"));
      this.destroy(new Error("socket hang up"));
    }
  });
  await assert.rejects(store.writeChunk(s.id, 5, broken, 5), code("CHUNK_ABORTED"));
  assert.equal(store.getSession(s.id).offset, 5);

  // No Content-Length and more bytes than the file has left.
  await assert.rejects(store.writeChunk(s.id, 5, Readable.from([Buffer.alloc(16)]), null), code("CHUNK_PAST_END"));
  assert.equal(store.getSession(s.id).offset, 5);
});

test("store: a file that isn't a video is discarded on complete", async () => {
  const dir = tmpLibrary();
  const store = makeStore(dir, { probe: async () => ({ unreadable: true, message: "Invalid data found" }) });
  const s = store.createSession({ folder: "Course", name: "fake.mp4", size: 3 });
  await store.writeChunk(s.id, 0, Readable.from([Buffer.from("abc")]), 3);
  await assert.rejects(store.complete(s.id), code("NOT_A_VIDEO"));
  assert.equal(fs.existsSync(path.join(dir, "Course", "fake.mp4")), false);
  assert.deepEqual(fs.readdirSync(path.join(dir, ".uploads")), []);
});

test("store: subtitles skip the video probe; cancel removes the session", async () => {
  const dir = tmpLibrary();
  let probed = false;
  const store = makeStore(dir, { probe: async () => { probed = true; return {}; } });
  const s = store.createSession({ folder: "Course", name: "a.vtt", size: 6 });
  await store.writeChunk(s.id, 0, Readable.from([Buffer.from("WEBVTT")]), 6);
  const result = await store.complete(s.id);
  assert.equal(result.kind, "subtitle");
  assert.equal(probed, false);

  const c = store.createSession({ folder: "Course", name: "b.mp4", size: 6 });
  assert.deepEqual(store.cancel(c.id), { ok: true, existed: true });
  assert.deepEqual(store.cancel(c.id), { ok: true, existed: false });
});

test("store: cleanup removes expired sessions only", () => {
  const dir = tmpLibrary();
  let t = 1_000_000;
  const store = makeStore(dir, { now: () => t });
  const old = store.createSession({ folder: "", name: "old.mp4", size: 5 });
  t += 23 * 3600 * 1000;
  const fresh = store.createSession({ folder: "", name: "fresh.mp4", size: 5 });
  t += 2 * 3600 * 1000;
  assert.equal(store.cleanup(), 1);
  assert.throws(() => store.getSession(old.id), code("SESSION_NOT_FOUND"));
  assert.equal(store.getSession(fresh.id).offset, 0);
});

// --- HTTP (standalone server) --------------------------------------------------------------

async function withServer(fn, { key = KEY } = {}) {
  const dir = tmpLibrary();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tylertube-state-"));
  const drive = startDriveServer({
    port: 0,
    videosDir: dir,
    stateFile: path.join(stateDir, "state.json"),
    visitorsFile: path.join(stateDir, "visitors.json"),
    geolocate: null,
    getUploadKey: () => key,
    uploadReserveBytes: 0
  });
  const port = await drive.ready;
  try {
    await fn(`http://127.0.0.1:${port}`, dir);
  } finally {
    await drive.close();
  }
}

const auth = { "X-Upload-Key": KEY };

test("http: key is required, wrong keys are rate-limited", async () => {
  await withServer(async (base) => {
    let res = await fetch(`${base}/api/upload/auth`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, "BAD_KEY");

    res = await fetch(`${base}/api/upload/auth`, { headers: auth });
    assert.equal(res.status, 200);
    const info = await res.json();
    assert.equal(info.ok, true);
    assert.equal(info.maxFolderDepth, 3);

    for (let i = 0; i < 10; i += 1) {
      res = await fetch(`${base}/api/upload/auth`, { headers: { "X-Upload-Key": "wrong-key-xxxxxx" } });
      assert.equal(res.status, 401);
    }
    res = await fetch(`${base}/api/upload/auth`, { headers: auth });
    assert.equal(res.status, 429);
    assert.equal((await res.json()).code, "TOO_MANY_ATTEMPTS");
  });
});

test("http: uploads are off without a configured key", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/upload/auth`, { headers: auth });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "UPLOADS_DISABLED");
  }, { key: "" });
});

test("http: create folder, upload a subtitle in chunks, list it", async () => {
  await withServer(async (base, dir) => {
    let res = await fetch(`${base}/api/upload/folders`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "New/Sub" })
    });
    assert.equal(res.status, 201);

    res = await fetch(`${base}/api/upload/folders`, { headers: auth });
    assert.deepEqual((await res.json()).folders, ["Course", "Course/Section", "New", "New/Sub"]);

    const body = Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n");
    res = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ folder: "New/Sub", name: "Clip.vtt", size: body.length })
    });
    assert.equal(res.status, 201);
    const { id } = await res.json();

    res = await fetch(`${base}/api/upload/session/${id}?offset=0`, { method: "PUT", headers: auth, body: body.subarray(0, 10) });
    assert.deepEqual(await res.json(), { offset: 10, size: body.length });

    res = await fetch(`${base}/api/upload/session/${id}?offset=0`, { method: "PUT", headers: auth, body: body.subarray(0, 10) });
    assert.equal(res.status, 409);
    const mismatch = await res.json();
    assert.equal(mismatch.code, "OFFSET_MISMATCH");
    assert.equal(mismatch.offset, 10);

    res = await fetch(`${base}/api/upload/session/${id}?offset=10`, { method: "PUT", headers: auth, body: body.subarray(10) });
    assert.equal(res.status, 200);

    res = await fetch(`${base}/api/upload/session/${id}/complete`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).path, "New/Sub/Clip.vtt");
    assert.deepEqual(fs.readFileSync(path.join(dir, "New", "Sub", "Clip.vtt")), body);
  });
});

test("http: errors are JSON with a code", async () => {
  await withServer(async (base) => {
    let res = await fetch(`${base}/api/upload/session/${"0".repeat(32)}`, { headers: auth });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, "SESSION_NOT_FOUND");

    res = await fetch(`${base}/api/upload`, { method: "POST", headers: auth, body: "{not json" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "BAD_REQUEST");

    res = await fetch(`${base}/api/upload`, { method: "POST", headers: auth, body: "null" });
    assert.equal(res.status, 400);

    // An oversized JSON body gets a real 413 reply, not a reset connection.
    res = await fetch(`${base}/api/upload`, { method: "POST", headers: auth, body: "x".repeat(64 * 1024) });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).code, "BODY_TOO_LARGE");

    res = await fetch(`${base}/api/upload/folders`, { method: "DELETE", headers: auth });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, POST");

    res = await fetch(`${base}/api/upload/nope`, { headers: auth });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, "NOT_FOUND");
  });
});
