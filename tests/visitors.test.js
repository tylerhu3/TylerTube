// Visitor log: pure helpers, the file store and the /api/visit + /api/visitors routes
// (server/visitors.js, mounted by server/standalone.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SESSION_GAP_MS,
  clientIp,
  countryFromHeaders,
  createVisitorStore,
  describeUserAgent,
  formatLocation,
  isPublicIp,
  maskIp
} from "../server/visitors.js";
import { startDriveServer } from "../server/standalone.js";
import { formatLastSeen } from "../src/lib/visitors.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "tt-visitors-"));
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

test("describeUserAgent names common browsers", () => {
  assert.equal(describeUserAgent(MAC_CHROME), "Chrome on macOS");
  assert.equal(describeUserAgent(IPHONE_SAFARI), "Safari on iPhone");
  assert.equal(describeUserAgent("Mozilla/5.0 (X11; Linux) Chrome/79 Tesla/2024.1"), "Tesla browser");
  assert.equal(describeUserAgent(""), "Unknown device");
});

test("maskIp hides the host part", () => {
  assert.equal(maskIp("73.12.34.56"), "73.12.x.x");
  assert.equal(maskIp("2601:646:a1b2::1"), "2601:646:…");
  assert.equal(maskIp("127.0.0.1"), "local");
  assert.equal(maskIp(""), "unknown");
});

test("clientIp prefers Cloudflare, then forwarded headers, then the socket", () => {
  const sock = { remoteAddress: "::ffff:127.0.0.1" };
  assert.equal(clientIp({ headers: { "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" }, socket: sock }), "1.2.3.4");
  assert.equal(clientIp({ headers: { "x-forwarded-for": "5.6.7.8, 127.0.0.1" }, socket: sock }), "5.6.7.8");
  assert.equal(clientIp({ headers: {}, socket: sock }), "127.0.0.1");
});

test("store counts visits per session gap, reuses id or IP+browser, keeps names", () => {
  const file = path.join(tmpDir(), "v.json");
  let t = 1_000_000;
  const store = createVisitorStore(file, { now: () => t });

  const a = store.record({ ip: "1.1.1.1", userAgent: MAC_CHROME });
  assert.equal(a.visits, 1);
  t += 60_000;
  assert.equal(store.record({ id: a.id, ip: "1.1.1.1", userAgent: MAC_CHROME }).visits, 1);
  t += SESSION_GAP_MS;
  assert.equal(store.record({ id: a.id, ip: "1.1.1.1", userAgent: MAC_CHROME, name: "  Tyler  " }).visits, 2);

  // New tunnel origin: no id, same IP + browser → same visitor, name kept.
  const again = store.record({ ip: "1.1.1.1", userAgent: MAC_CHROME });
  assert.equal(again.id, a.id);
  assert.equal(again.name, "Tyler");

  t += 1000;
  const b = store.record({ id: "phone-visitor-1", ip: "2.2.2.2", userAgent: IPHONE_SAFARI });
  assert.equal(b.id, "phone-visitor-1");
  assert.equal(b.device, "Safari on iPhone");

  // Persisted, newest first.
  const reloaded = createVisitorStore(file).list();
  assert.deepEqual(reloaded.map((v) => v.id), ["phone-visitor-1", a.id]);
});

test("formatLastSeen buckets", () => {
  const now = 10 * 86_400_000;
  assert.equal(formatLastSeen(now - 10_000, now), "just now");
  assert.equal(formatLastSeen(now - 5 * 60_000, now), "5 min ago");
  assert.equal(formatLastSeen(now - 3 * 3_600_000, now), "3 h ago");
  assert.equal(formatLastSeen(now - 2 * 86_400_000, now), "2 d ago");
});

test("standalone server serves /api/visit and /api/visitors with masked IPs", async () => {
  const dir = tmpDir();
  const drive = startDriveServer({
    port: 0,
    videosDir: dir,
    stateFile: path.join(dir, "s.json"),
    visitorsFile: path.join(dir, "v.json"),
    geolocate: null
  });
  const port = await drive.ready;
  const base = `http://127.0.0.1:${port}`;
  try {
    const visit = await fetch(`${base}/api/visit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "73.12.34.56",
        "CF-IPCountry": "US",
        "User-Agent": MAC_CHROME
      },
      body: JSON.stringify({ name: "Guest" })
    });
    assert.equal(visit.status, 200);
    const { id, visitor } = await visit.json();
    assert.equal(typeof id, "string");
    assert.equal(visitor.name, "Guest");
    assert.equal(visitor.ip, "73.12.x.x");
    assert.equal(visitor.location, "US");

    const list = await (await fetch(`${base}/api/visitors`)).json();
    assert.equal(list.visitors.length, 1);
    assert.equal(list.visitors[0].ip, "73.12.x.x");
    assert.equal(list.visitors[0].userAgent, undefined);
    assert.ok(fs.readFileSync(path.join(dir, "v.json"), "utf8").includes("73.12.34.56"));

    assert.equal((await fetch(`${base}/api/visit`, { method: "POST", body: "{nope" })).status, 400);
    assert.equal((await fetch(`${base}/api/visitors`, { method: "POST" })).status, 405);
  } finally {
    await drive.close();
  }
});

test("isPublicIp skips private, loopback and CGNAT ranges", () => {
  assert.equal(isPublicIp("73.12.34.56"), true);
  assert.equal(isPublicIp("2601:646:a1b2::1"), true);
  for (const ip of ["", "127.0.0.1", "10.0.0.2", "172.20.1.1", "192.168.1.5", "100.64.0.1", "169.254.1.1", "::1", "fd00::1", "fe80::1"]) {
    assert.equal(isPublicIp(ip), false, ip);
  }
});

test("formatLocation and countryFromHeaders", () => {
  assert.equal(formatLocation({ city: "Austin", region: "Texas", country: "United States" }), "Austin, Texas, United States");
  assert.equal(formatLocation({ city: "Singapore", region: "Singapore", country: "Singapore" }), "Singapore");
  assert.equal(formatLocation(null), "");
  assert.equal(countryFromHeaders({ "cf-ipcountry": "de" }), "DE");
  assert.equal(countryFromHeaders({ "cf-ipcountry": "XX" }), "");
  assert.equal(countryFromHeaders({}), "");
});

test("store looks up location once per IP in the background and resets it on a new IP", async () => {
  const file = path.join(tmpDir(), "v.json");
  const calls = [];
  const places = {
    "73.12.34.56": { city: "Austin", region: "Texas", country: "United States" },
    "81.2.69.160": { city: "London", region: "England", country: "United Kingdom" }
  };
  const store = createVisitorStore(file, {
    geolocate: async (ip) => {
      calls.push(ip);
      return places[ip] || null;
    }
  });

  const a = store.record({ ip: "73.12.34.56", userAgent: MAC_CHROME, country: "US" });
  store.record({ ip: "73.12.34.56", userAgent: IPHONE_SAFARI }); // same IP, other device
  await store.settled();
  assert.deepEqual(calls, ["73.12.34.56"]);
  assert.equal(store.list().find((v) => v.id === a.id).location, "Austin, Texas, United States");
  assert.ok(store.list().every((v) => v.location === "Austin, Texas, United States"));

  store.record({ id: a.id, ip: "73.12.34.56", userAgent: MAC_CHROME });
  await store.settled();
  assert.equal(calls.length, 1);

  store.record({ id: a.id, ip: "81.2.69.160", userAgent: MAC_CHROME });
  await store.settled();
  assert.equal(createVisitorStore(file).list().find((v) => v.id === a.id).location, "London, England, United Kingdom");

  // Private IPs are never looked up.
  store.record({ ip: "192.168.1.5", userAgent: MAC_CHROME + " x" });
  await store.settled();
  assert.equal(calls.length, 2);
});
