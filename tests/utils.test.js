import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDriveTime, BUFFER_OPTIONS } from "../src/components/drive/driveUtils.js";

test("formatDriveTime", () => {
  assert.equal(formatDriveTime(0), "0:00");
  assert.equal(formatDriveTime(65.9), "1:05");
  assert.equal(formatDriveTime(3600 + 62), "1:01:02");
  assert.equal(formatDriveTime(-5), "0:00");
  assert.equal(formatDriveTime(NaN), "0:00");
});

test("BUFFER_OPTIONS targets match DriveVideoPlayer's bufferMode mapping", () => {
  assert.deepEqual(BUFFER_OPTIONS.map((o) => o.target), [1.0, 2.0, 5.0]);
});

import { formatDuration } from "../src/utils/format.js";
test("formatDuration", () => {
  assert.equal(formatDuration(undefined), "");
  assert.equal(formatDuration(0), "");
  assert.equal(formatDuration(65), "01:05");
  assert.equal(formatDuration(3725), "1:02:05");
});

import { readJSON, readString, writeJSON, writeString, removeKey } from "../src/lib/storage.js";
test("storage helpers never throw and round-trip", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  writeJSON("a", { x: 1 });
  assert.deepEqual(readJSON("a", {}), { x: 1 });
  writeString("b", "hi");
  assert.equal(readString("b"), "hi");
  removeKey("b");
  assert.equal(readString("b", "dflt"), "dflt");
  store.set("bad", "{not json");
  assert.deepEqual(readJSON("bad", { ok: true }), { ok: true });
  globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); }, removeItem() { throw new Error("x"); } };
  assert.equal(readString("a", "f"), "f");
  assert.doesNotThrow(() => { writeJSON("a", 1); writeString("a", "1"); removeKey("a"); });
  delete globalThis.localStorage;
});
