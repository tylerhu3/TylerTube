// Standalone Drive server (server/standalone.js): HTTP routes and the /ws/mpeg1 error path.
// No ffmpeg needed: the requested file doesn't exist, so drive-ws.js never spawns it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { startDriveServer } from "../server/standalone.js";

async function withServer(fn) {
  const videosDir = fs.mkdtempSync(path.join(os.tmpdir(), "tylertube-drive-"));
  const drive = startDriveServer({ port: 0, videosDir });
  const port = await drive.ready;
  try {
    await fn(port);
  } finally {
    await drive.close();
    fs.rmSync(videosDir, { recursive: true, force: true });
  }
}

test("standalone: /healthz is 200, other paths (incl. removed /api/live-audio) 404", async () => {
  await withServer(async (port) => {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok\n");

    const api = await fetch(`http://127.0.0.1:${port}/api/live-audio?file=nope.mp4`);
    assert.equal(api.status, 404);
    await api.text();
  });
});

test("standalone: /ws/mpeg1 with a missing file sends an error and closes", async () => {
  await withServer(async (port) => {
    const missing = `nope-${process.pid}-${Date.now()}.mp4`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/mpeg1?file=${missing}`);
    const messages = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise((resolve, reject) => {
      ws.on("close", resolve);
      ws.on("error", reject);
    });
    assert.deepEqual(messages, [{ type: "error", message: "Video file not found" }]);
  });
});

test("standalone: upgrades on other paths are rejected", async () => {
  await withServer(async (port) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/other`);
    await assert.rejects(
      new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      })
    );
  });
});
