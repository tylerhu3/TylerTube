// Visitor log: who has opened the site, shown in the hamburger menu (SideMenu.jsx).
//
//   POST /api/visit     body { id?, name? } → records a visit, returns { id, visitor }.
//                       `id` is the browser's visitor id (localStorage); a new one is issued if
//                       missing. Each quick-tunnel URL starts with empty localStorage, so an
//                       unknown id from the same IP + browser reuses that visitor's entry.
//   GET  /api/visitors  → { visitors: [...] } newest first, IPs masked.
//
// Location: Cloudflare's CF-IPCountry header gives the country right away; the city/region come
// from a server-side IP lookup (ipwho.is, HTTPS, no key) done in the background once per new IP,
// so /api/visit never waits on it. TYLERTUBE_GEOIP=0 turns the lookup off.
//
// Full IPs stay in the file (data/visitors.json; dev: visitors.dev.json); the list sent to
// browsers only shows a masked one, since anyone with the tunnel URL can open the menu.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { clientIp, readBody, sendJSON } from "./http-utils.js";

export { clientIp };

export const VISIT_ROUTE = "/api/visit";
export const VISITORS_ROUTE = "/api/visitors";
export const SESSION_GAP_MS = 30 * 60 * 1000; // a new visit after 30 min of silence
const MAX_VISITORS = 500;
const MAX_NAME_LENGTH = 40;
const MAX_BODY_BYTES = 4 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function maskIp(ip) {
  if (!ip) return "unknown";
  if (ip === "127.0.0.1" || ip === "::1") return "local";
  const v4 = ip.split(".");
  if (v4.length === 4) return `${v4[0]}.${v4[1]}.x.x`;
  const v6 = ip.split(":").filter(Boolean);
  return v6.length ? `${v6.slice(0, 2).join(":")}:…` : "unknown";
}

// "Chrome on macOS", "Tesla browser", "Safari on iPhone", …
export function describeUserAgent(ua = "") {
  if (!ua) return "Unknown device";
  if (/Tesla/i.test(ua)) return "Tesla browser";
  let os = "";
  if (/iPhone/.test(ua)) os = "iPhone";
  else if (/iPad/.test(ua)) os = "iPad";
  else if (/Android/.test(ua)) os = "Android";
  else if (/CrOS/.test(ua)) os = "ChromeOS";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/Mac OS X|Macintosh/.test(ua)) os = "macOS";
  else if (/Linux/.test(ua)) os = "Linux";
  let browser = "";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\//.test(ua)) browser = "Opera";
  else if (/Firefox\/|FxiOS/.test(ua)) browser = "Firefox";
  else if (/Chrome\/|CriOS/.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua)) browser = "Safari";
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || "Unknown device";
}

// Loopback, private, link-local, CGNAT and ULA addresses have no meaningful location.
export function isPublicIp(ip) {
  if (!ip) return false;
  const v4 = ip.split(".").map(Number);
  if (v4.length === 4 && v4.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = v4;
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  if (!ip.includes(":")) return false;
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return false;
  return !/^(fe[89ab]|f[cd])/.test(lower);
}

const COUNTRY_CODE = /^[A-Z]{2}$/;

// CF-IPCountry ("US"); "XX"/"T1" (unknown / Tor) are dropped.
export function countryFromHeaders(headers = {}) {
  const code = String(headers["cf-ipcountry"] || "").trim().toUpperCase();
  return COUNTRY_CODE.test(code) && code !== "XX" && code !== "T1" ? code : "";
}

const MAX_PLACE_LENGTH = 60;
const cleanPlace = (s) =>
  typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_PLACE_LENGTH) : "";

// { city, region, country } → "Austin, Texas, United States"; repeated parts are skipped.
export function formatLocation(loc) {
  if (!loc) return "";
  const parts = [];
  for (const part of [loc.city, loc.region, loc.country].map(cleanPlace)) {
    if (part && !parts.includes(part)) parts.push(part);
  }
  return parts.join(", ");
}

// Default geolocator: ipwho.is over HTTPS. Resolves to { city, region, country } or null.
export async function lookupIpLocation(ip, { timeoutMs = 4000 } = {}) {
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,city,region,country`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.success) return null;
    const loc = { city: cleanPlace(data.city), region: cleanPlace(data.region), country: cleanPlace(data.country) };
    return loc.city || loc.region || loc.country ? loc : null;
  } catch {
    return null;
  }
}

// Geolocator for the servers: off with TYLERTUBE_GEOIP=0.
export function defaultGeolocate() {
  return process.env.TYLERTUBE_GEOIP === "0" ? null : lookupIpLocation;
}

export function cleanName(name) {
  if (typeof name !== "string") return "";
  return name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME_LENGTH);
}

export function publicVisitor(v) {
  return {
    id: v.id,
    name: v.name || "",
    device: v.device,
    ip: maskIp(v.ip),
    location: v.location || v.country || "",
    firstSeen: v.firstSeen,
    lastSeen: v.lastSeen,
    visits: v.visits
  };
}

// geolocate(ip) → Promise<{ city, region, country } | null>; omit/null for no lookups.
export function createVisitorStore(filePath, { now = () => Date.now(), geolocate = null } = {}) {
  let visitors = null; // id → visitor
  const lookups = new Map(); // ip → in-flight Promise<string>, so one IP is looked up once at a time
  const inFlight = new Set(); // locate() promises, for settled()

  // Background: fill visitor.location for its current IP, then save. Returns the promise (tests).
  function locate(visitor) {
    const ip = visitor.ip;
    if (!geolocate || !isPublicIp(ip) || visitor.locationIp === ip) return Promise.resolve();
    // Another visitor already resolved this IP: copy it.
    const known = [...visitors.values()].find((v) => v.locationIp === ip && v.location);
    if (known) {
      visitor.location = known.location;
      visitor.locationIp = ip;
      save();
      return Promise.resolve();
    }
    if (!lookups.has(ip)) {
      lookups.set(
        ip,
        Promise.resolve()
          .then(() => geolocate(ip))
          .then((loc) => formatLocation(loc))
          .catch(() => "")
          .finally(() => lookups.delete(ip))
      );
    }
    return lookups.get(ip).then((location) => {
      // The visitor may have moved on to another IP (or been pruned) meanwhile.
      if (!location || visitor.ip !== ip || visitors.get(visitor.id) !== visitor) return;
      visitor.location = location;
      visitor.locationIp = ip;
      try {
        save();
      } catch (err) {
        console.error(`[visitors] could not save ${filePath}: ${err.message}`);
      }
    });
  }

  function load() {
    if (visitors) return visitors;
    visitors = new Map();
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      for (const v of Array.isArray(parsed?.visitors) ? parsed.visitors : []) {
        if (v && typeof v.id === "string") visitors.set(v.id, v);
      }
    } catch (err) {
      if (err.code !== "ENOENT") console.error(`[visitors] could not read ${filePath}: ${err.message}`);
    }
    return visitors;
  }

  function save() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, visitors: [...visitors.values()] }));
    fs.renameSync(tmp, filePath);
  }

  function prune() {
    if (visitors.size <= MAX_VISITORS) return;
    const oldest = [...visitors.values()].sort((a, b) => a.lastSeen - b.lastSeen);
    for (const v of oldest.slice(0, visitors.size - MAX_VISITORS)) visitors.delete(v.id);
  }

  return {
    // { id?, name?, ip, userAgent, country? } → the stored visitor (full record).
    record({ id, name, ip = "", userAgent = "", country = "" }) {
      const all = load();
      const t = now();
      const device = describeUserAgent(userAgent);
      let visitor = ID_PATTERN.test(id || "") ? all.get(id) : undefined;
      if (!visitor && ip) {
        // Same browser on a new tunnel origin (fresh localStorage): reuse the newest match.
        visitor = [...all.values()]
          .filter((v) => v.ip === ip && v.userAgent === userAgent)
          .sort((a, b) => b.lastSeen - a.lastSeen)[0];
      }
      if (!visitor) {
        visitor = {
          id: ID_PATTERN.test(id || "") ? id : crypto.randomUUID(),
          name: "",
          firstSeen: t,
          lastSeen: t,
          visits: 0
        };
        all.set(visitor.id, visitor);
      }
      if (visitor.visits === 0 || t - visitor.lastSeen >= SESSION_GAP_MS) visitor.visits += 1;
      visitor.lastSeen = t;
      if (visitor.ip !== ip) {
        // New network: the old city no longer applies.
        delete visitor.location;
        delete visitor.locationIp;
      }
      visitor.ip = ip;
      if (country) visitor.country = country;
      visitor.userAgent = userAgent;
      visitor.device = device;
      const cleaned = cleanName(name);
      if (typeof name === "string") visitor.name = cleaned;
      prune();
      save();
      const pending = locate(visitor);
      inFlight.add(pending);
      pending.finally(() => inFlight.delete(pending));
      return visitor;
    },
    // Resolves once every background location lookup started so far is done (tests, shutdown).
    settled() {
      return Promise.all([...inFlight]).then(() => undefined);
    },
    list() {
      return [...load().values()].sort((a, b) => b.lastSeen - a.lastSeen);
    }
  };
}

// Connect-style handler like createUserStateHandler; returns true if it handled the request.
export function createVisitorsHandler(store) {
  return async function visitorsHandler(req, res, next) {
    const [pathname] = (req.url || "").split("?");
    if (pathname !== VISIT_ROUTE && pathname !== VISITORS_ROUTE) {
      if (next) next();
      return false;
    }
    try {
      if (pathname === VISITORS_ROUTE && req.method === "GET") {
        sendJSON(res, 200, { visitors: store.list().map(publicVisitor) });
      } else if (pathname === VISIT_ROUTE && req.method === "POST") {
        let body = {};
        try {
          const raw = await readBody(req, MAX_BODY_BYTES);
          body = raw ? JSON.parse(raw) : {};
        } catch (err) {
          if (err.status) throw err;
          sendJSON(res, 400, { error: "Invalid JSON" });
          return true;
        }
        const visitor = store.record({
          id: typeof body?.id === "string" ? body.id : undefined,
          name: body?.name,
          ip: clientIp(req),
          country: countryFromHeaders(req.headers),
          userAgent: String(req.headers["user-agent"] || "").slice(0, 400)
        });
        sendJSON(res, 200, { id: visitor.id, visitor: publicVisitor(visitor) });
      } else {
        res.writeHead(405, { Allow: pathname === VISIT_ROUTE ? "POST" : "GET" });
        res.end();
      }
    } catch (err) {
      if (!res.headersSent) sendJSON(res, err.status || 500, { error: err.message });
      if (!err.status) console.error(`[visitors] ${err.stack || err.message}`);
    }
    return true;
  };
}
