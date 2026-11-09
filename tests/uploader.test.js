// Client upload engine (src/lib/uploader.js) against a fake server: chunking, retries after a
// dropped connection, offset resync, and readable errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UploadFailure,
  bytesPerSecond,
  createUploadClient,
  failureFromResponse,
  precheckFile
} from "../src/lib/uploader.js";

const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
const raw = (status, text) => ({ ok: status < 400, status, text: async () => text });

// Minimal in-memory server. `faults` is a queue of functions that may return a response (or
// throw) to override the next PUT.
function fakeServer({ chunkBytes = 4, faults = [] } = {}) {
  const state = { id: "f".repeat(32), received: Buffer.alloc(0), size: 0, puts: 0, completed: null };
  const fetchImpl = async (url, init) => {
    const u = new URL(url, "http://x");
    const p = u.pathname;
    if (init.headers["X-Upload-Key"] !== "k") return json(401, { error: "Wrong upload key.", code: "BAD_KEY" });
    if (p === "/api/upload" && init.method === "POST") {
      const body = JSON.parse(init.body);
      state.size = body.size;
      return json(201, { id: state.id, offset: state.received.length, chunkBytes, resumed: false });
    }
    if (p.endsWith("/complete")) {
      state.completed = JSON.parse(init.body);
      return json(200, { path: `x/${state.completed.name}`, kind: "video" });
    }
    if (init.method === "GET") return json(200, { offset: state.received.length, size: state.size });
    if (init.method === "PUT") {
      state.puts += 1;
      const fault = faults.shift();
      const offset = Number(u.searchParams.get("offset"));
      const bytes = Buffer.from(await init.body.arrayBuffer());
      if (fault) {
        const out = fault({ state, offset, bytes });
        if (out) return out;
      }
      if (offset !== state.received.length) {
        return json(409, { error: "mismatch", code: "OFFSET_MISMATCH", offset: state.received.length });
      }
      state.received = Buffer.concat([state.received, bytes]);
      return json(200, { offset: state.received.length, size: state.size });
    }
    return json(404, { error: "?", code: "NOT_FOUND" });
  };
  return { state, fetchImpl };
}

const file = (text, name = "Clip.mp4") => new File([text], name);
const noSleep = async () => {};

test("uploads in chunks and completes", async () => {
  const { state, fetchImpl } = fakeServer();
  const client = createUploadClient({ getKey: () => "k", fetchImpl, sleep: noSleep });
  const progress = [];
  const result = await client.uploadFile(file("0123456789"), "Course", { onProgress: (p) => progress.push(p.loaded) });
  assert.equal(state.received.toString(), "0123456789");
  assert.equal(state.puts, 3);
  assert.deepEqual(progress, [0, 4, 8, 10]);
  assert.equal(result.path, "x/Clip.mp4");
  assert.deepEqual(state.completed, { name: "Clip.mp4" });
});

test("a chunk that landed but whose reply was lost isn't sent twice", async () => {
  const { state, fetchImpl } = fakeServer({
    faults: [
      () => null,
      ({ state: s, bytes }) => {
        s.received = Buffer.concat([s.received, bytes]); // written…
        throw new TypeError("Failed to fetch"); // …but the connection dropped
      }
    ]
  });
  const retries = [];
  const client = createUploadClient({ getKey: () => "k", fetchImpl, sleep: noSleep });
  await client.uploadFile(file("0123456789"), "", { onRetry: (f) => retries.push(f.code) });
  assert.equal(state.received.toString(), "0123456789");
  assert.deepEqual(retries, ["NETWORK"]);
});

test("gateway errors are retried; final errors are not", async () => {
  const gateway = fakeServer({ faults: [() => raw(524, "<html>timeout</html>")] });
  const client = createUploadClient({ getKey: () => "k", fetchImpl: gateway.fetchImpl, sleep: noSleep });
  await client.uploadFile(file("abcdef"), "");
  assert.equal(gateway.state.received.toString(), "abcdef");

  const full = fakeServer({ faults: [() => json(507, { error: "Not enough disk space", code: "DISK_FULL" })] });
  const client2 = createUploadClient({ getKey: () => "k", fetchImpl: full.fetchImpl, sleep: noSleep });
  await assert.rejects(client2.uploadFile(file("abcdef"), ""), (err) => {
    assert.equal(err.code, "DISK_FULL");
    assert.equal(err.message, "Not enough disk space");
    assert.equal(err.sessionId, full.state.id);
    return true;
  });
});

test("gives up after repeated transient failures", async () => {
  const always = () => raw(502, "bad gateway");
  const { fetchImpl } = fakeServer({ faults: [always, always, always, always, always, always] });
  const client = createUploadClient({ getKey: () => "k", fetchImpl, sleep: noSleep });
  await assert.rejects(client.uploadFile(file("abcdef"), ""), (err) => err.code === "BAD_GATEWAY" && err.retryable);
});

test("abort turns into CANCELED", async () => {
  const controller = new AbortController();
  const { fetchImpl } = fakeServer({
    faults: [
      () => {
        controller.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
    ]
  });
  const client = createUploadClient({ getKey: () => "k", fetchImpl, sleep: noSleep });
  await assert.rejects(client.uploadFile(file("abcdef"), "", { signal: controller.signal }), (err) => err.code === "CANCELED");
});

test("a finished-but-unacknowledged upload counts as done", async () => {
  const result = { path: "x/Clip.mp4", kind: "video" };
  const { fetchImpl } = fakeServer({ faults: [() => json(409, { error: "done", code: "ALREADY_COMPLETE", result })] });
  const client = createUploadClient({ getKey: () => "k", fetchImpl, sleep: noSleep });
  assert.deepEqual(await client.uploadFile(file("abcdef"), ""), result);

  // Retry with the old session id: the server says it's done, nothing is re-sent.
  let puts = 0;
  const client2 = createUploadClient({
    getKey: () => "k",
    sleep: noSleep,
    fetchImpl: async (url, init) => {
      if (init.method === "PUT") puts += 1;
      return json(200, { offset: 6, size: 6, done: true, result });
    }
  });
  assert.deepEqual(await client2.uploadFile(file("abcdef"), "", { previousSessionId: "f".repeat(32) }), result);
  assert.equal(puts, 0);
});

test("BUSY is waited out without using up retries", async () => {
  const busy = () => json(409, { error: "busy", code: "BUSY" });
  const { state, fetchImpl } = fakeServer({ faults: [busy, busy, busy, busy, busy, busy, busy] });
  const client = createUploadClient({ getKey: () => "k", fetchImpl, sleep: noSleep });
  await client.uploadFile(file("abcdef"), "");
  assert.equal(state.received.toString(), "abcdef");
});

test("failureFromResponse explains non-JSON replies", () => {
  assert.equal(failureFromResponse(404, null).code, "API_MISSING");
  assert.equal(failureFromResponse(413, null).code, "PROXY_TOO_LARGE");
  assert.equal(failureFromResponse(522, null).retryable, true);
  const f = failureFromResponse(409, { error: "taken", code: "NAME_TAKEN", suggestion: "a (2).mp4" });
  assert.ok(f instanceof UploadFailure);
  assert.equal(f.suggestion, "a (2).mp4");
  assert.equal(f.retryable, false);
});

test("precheckFile and bytesPerSecond", () => {
  assert.equal(precheckFile(file("x", "a.mp4")), "");
  assert.match(precheckFile(file("x", "a.exe")), /aren't supported/);
  assert.match(precheckFile(file("", "a.mp4")), /empty/);
  assert.match(precheckFile(file("xx", "a.mp4"), { maxFileBytes: 1 }), /limit/);
  assert.equal(bytesPerSecond([{ t: 0, loaded: 0 }, { t: 2000, loaded: 4000 }]), 2000);
  assert.equal(bytesPerSecond([{ t: 0, loaded: 0 }]), 0);
});
