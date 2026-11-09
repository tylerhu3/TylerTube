// Small HTTP helpers shared by the JSON API routes (user-state.js, visitors.js, upload.js).

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

export function sendJSON(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(JSON.stringify(body));
}

// Reads the whole body as UTF-8. Rejects with err.status = 413 past maxBytes.
export function readBody(req, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        // Stop buffering but keep draining (no destroy), so the caller's 413 reply reaches the
        // client instead of a reset connection.
        done = true;
        chunks.length = 0;
        req.resume();
        reject(Object.assign(new Error("Body too large"), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

// readBody + JSON.parse into a plain object ({} for an empty body); anything else rejects
// with status 400.
export async function readJSONBody(req, maxBytes) {
  const raw = await readBody(req, maxBytes);
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("Expected a JSON object"), { status: 400 });
  }
  return parsed;
}

// Client IP behind Cloudflare tunnel → Nginx → this server.
export function clientIp(req) {
  const h = req.headers || {};
  const first = (v) => (typeof v === "string" ? v.split(",")[0].trim() : "");
  const ip =
    first(h["cf-connecting-ip"]) ||
    first(h["x-forwarded-for"]) ||
    first(h["x-real-ip"]) ||
    req.socket?.remoteAddress ||
    "";
  return ip.replace(/^::ffff:/, "");
}
