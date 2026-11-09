// Synced user state: merge rules (src/lib/syncMerge.js), the file store and the /api/state
// route on the standalone server (server/user-state.js, server/standalone.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeStates, sanitizeState } from "../src/lib/syncMerge.js";
import { createUserStateStore } from "../server/user-state.js";
import { startDriveServer } from "../server/standalone.js";

const entry = (time, modifiedAt, extra = {}) => ({
  time,
  duration: 100,
  completed: false,
  watched: true,
  hiddenFromHistory: false,
  updatedAt: modifiedAt,
  modifiedAt,
  ...extra
});

test("sanitizeState drops junk and unknown fields, fills entry defaults", () => {
  const clean = sanitizeState({
    progress: { a: { time: 5 }, b: "nope", "": entry(1, 1) },
    fields: {
      theme: { value: "dark", modifiedAt: 3 },
      favorites: { value: "not-an-object", modifiedAt: 3 },
      evil: { value: "x", modifiedAt: 9 }
    }
  });
  assert.deepEqual(Object.keys(clean.progress), ["a"]);
  assert.equal(clean.progress.a.modifiedAt, 0);
  assert.equal(clean.progress.a.watched, false);
  assert.deepEqual(clean.fields, { theme: { value: "dark", modifiedAt: 3 } });
  assert.deepEqual(sanitizeState(null), { progress: {}, fields: {} });
});

test("legacy entries without modifiedAt fall back to updatedAt", () => {
  const clean = sanitizeState({ progress: { a: { time: 1, updatedAt: 42 } } });
  assert.equal(clean.progress.a.modifiedAt, 42);
});

test("mergeStates: newer modifiedAt wins per video and per field; omission never deletes", () => {
  const server = sanitizeState({
    progress: { a: entry(10, 100), b: entry(20, 100) },
    fields: { theme: { value: "dark", modifiedAt: 50 }, favorites: { value: { a: {} }, modifiedAt: 10 } }
  });
  const device = sanitizeState({
    progress: { a: entry(30, 200), b: entry(5, 50), c: entry(1, 1) },
    fields: { theme: { value: "light", modifiedAt: 40 }, favorites: { value: {}, modifiedAt: 20 } }
  });
  const merged = mergeStates(server, device);
  assert.equal(merged.progress.a.time, 30); // device newer
  assert.equal(merged.progress.b.time, 20); // server newer
  assert.equal(merged.progress.c.time, 1); // only on device
  assert.equal(merged.fields.theme.value, "dark");
  assert.deepEqual(merged.fields.favorites.value, {}); // newer clear wins

  const fromEmpty = mergeStates(server, sanitizeState({}));
  assert.deepEqual(fromEmpty, server);
});

test("mergeStates: a tie keeps the existing value", () => {
  const a = sanitizeState({ fields: { theme: { value: "dark", modifiedAt: 5 } } });
  const b = sanitizeState({ fields: { theme: { value: "light", modifiedAt: 5 } } });
  assert.equal(mergeStates(a, b).fields.theme.value, "dark");
});

test("store persists merges per profile and survives a reload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tylertube-state-"));
  const file = path.join(dir, "nested", "state.json");
  try {
    const store = createUserStateStore(file);
    store.merge("default", { progress: { a: entry(10, 1) } });
    store.merge("other", { fields: { theme: { value: "dark", modifiedAt: 1 } } });
    const reloaded = createUserStateStore(file);
    assert.equal(reloaded.get("default").progress.a.time, 10);
    assert.deepEqual(reloaded.get("default").fields, {});
    assert.equal(reloaded.get("other").fields.theme.value, "dark");
    assert.deepEqual(reloaded.get("missing"), { progress: {}, fields: {} });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store moves an unreadable file aside instead of overwriting it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tylertube-state-"));
  const file = path.join(dir, "state.json");
  const origError = console.error;
  console.error = () => {};
  try {
    fs.writeFileSync(file, "{not json");
    const store = createUserStateStore(file);
    assert.deepEqual(store.get("default"), { progress: {}, fields: {} });
    assert.ok(fs.readdirSync(dir).some((n) => n.startsWith("state.json.corrupt-")));
  } finally {
    console.error = origError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("standalone: /api/state GET/POST round-trip, 400 on bad JSON, 405 otherwise", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tylertube-state-"));
  const drive = startDriveServer({ port: 0, videosDir: dir, stateFile: path.join(dir, "s.json") });
  const port = await drive.ready;
  const url = `http://127.0.0.1:${port}/api/state`;
  try {
    const empty = await fetch(url);
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get("cache-control"), "no-store");
    assert.deepEqual(await empty.json(), { progress: {}, fields: {} });

    // text/plain body, as navigator.sendBeacon sends it
    const posted = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ progress: { a: entry(7, 5) } })
    });
    assert.equal(posted.status, 200);
    assert.equal((await posted.json()).progress.a.time, 7);

    const older = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ progress: { a: entry(1, 4) } })
    });
    assert.equal((await older.json()).progress.a.time, 7);

    const bad = await fetch(url, { method: "POST", body: "{nope" });
    assert.equal(bad.status, 400);
    await bad.text();

    const put = await fetch(url, { method: "PUT", body: "{}" });
    assert.equal(put.status, 405);
    await put.text();
  } finally {
    await drive.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
