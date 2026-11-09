// public/videos fingerprint + auto-rebuild decision (server/video-signature.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeVideoSignature,
  readRecordedSignature,
  recordSignature,
  shouldRebuild
} from "../server/video-signature.js";

test("signature changes on add/grow/remove, ignores dotfiles, recurses", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tylertube-sig-"));
  try {
    fs.mkdirSync(path.join(dir, "Show"));
    fs.writeFileSync(path.join(dir, "Show", "ep1.mp4"), "a");
    const base = computeVideoSignature(dir);
    assert.equal(base.files, 1);

    fs.writeFileSync(path.join(dir, ".DS_Store"), "x");
    fs.writeFileSync(path.join(dir, "Show", "._ep1.mp4"), "x");
    assert.equal(computeVideoSignature(dir).signature, base.signature);

    fs.writeFileSync(path.join(dir, "Show", "ep2.mp4"), "b");
    const added = computeVideoSignature(dir);
    assert.notEqual(added.signature, base.signature);

    fs.appendFileSync(path.join(dir, "Show", "ep2.mp4"), "more");
    assert.notEqual(computeVideoSignature(dir).signature, added.signature);

    fs.rmSync(path.join(dir, "Show", "ep2.mp4"));
    assert.equal(computeVideoSignature(dir).signature, base.signature);
    assert.equal(computeVideoSignature(path.join(dir, "missing")).files, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recordSignature / readRecordedSignature round-trip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tylertube-sig-"));
  const file = path.join(dir, "nested", "sig.json");
  try {
    assert.equal(readRecordedSignature(file), null);
    recordSignature("abc", file);
    assert.equal(readRecordedSignature(file), "abc");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldRebuild waits for a stable, changed, not-already-failed folder", () => {
  const base = { current: "new", built: "old", failed: null, stableMs: 60_000 };
  const seen = { signature: "new", since: 1000 };
  assert.equal(shouldRebuild({ ...base, seen, now: 30_000 }), false); // still settling
  assert.equal(shouldRebuild({ ...base, seen, now: 61_000 }), true);
  assert.equal(shouldRebuild({ ...base, built: "new", seen, now: 99_000 }), false); // up to date
  assert.equal(shouldRebuild({ ...base, failed: "new", seen, now: 99_000 }), false);
  assert.equal(shouldRebuild({ ...base, seen: { signature: "other", since: 0 }, now: 99_000 }), false);
});
