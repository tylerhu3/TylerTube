// Standalone Drive server for production: `npm run server` (no Vite).
// Serves the /ws/mpeg1 WebSocket (server/drive-ws.js) on 127.0.0.1:$DRIVE_PORT (default 5180);
// Nginx proxies /ws/mpeg1 and /api/ here. /api/state = synced user state (server/user-state.js),
// /api/visit + /api/visitors = visitor log (server/visitors.js),
// /api/upload* = uploads into public/videos (server/upload.js),
// GET /healthz → 200 for smoke tests; everything else → 404.
// In dev, the Vite plugin (server/plugin.js) attaches the same handler to :5173 instead.
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { attachDriveWebSocketServer } from "./drive-ws.js";
import { createUserStateHandler, createUserStateStore } from "./user-state.js";
import { createVisitorStore, createVisitorsHandler, defaultGeolocate } from "./visitors.js";
import { createUploadHandler, defaultUploadKey, signatureCatalogStatus } from "./upload.js";
import { createUploadStore } from "./upload-store.js";

export const DEFAULT_DRIVE_PORT = 5180;
const SHUTDOWN_TIMEOUT_MS = 2000;

// Relative to this file, not process.cwd(). (resolveLocalVideoFile's basename fallback still uses
// cwd; npm and the launchd plist both run from the repo root.)
const DEFAULT_VIDEOS_DIR = fileURLToPath(new URL("../public/videos", import.meta.url));
// Gitignored. Override with TYLERTUBE_STATE_FILE.
export const DEFAULT_STATE_FILE = fileURLToPath(new URL("../data/user-state.json", import.meta.url));
// Gitignored. Override with TYLERTUBE_VISITORS_FILE.
export const DEFAULT_VISITORS_FILE = fileURLToPath(new URL("../data/visitors.json", import.meta.url));

// Optional GB override from the environment; undefined → the store's default (5 GB).
function envGigabytes(name) {
  const gb = parseFloat(process.env[name] || "");
  return Number.isFinite(gb) && gb >= 0 ? gb * 1024 ** 3 : undefined;
}

export function startDriveServer({
  port = DEFAULT_DRIVE_PORT,
  host = "127.0.0.1",
  videosDir = DEFAULT_VIDEOS_DIR,
  stateFile = process.env.TYLERTUBE_STATE_FILE || DEFAULT_STATE_FILE,
  visitorsFile = process.env.TYLERTUBE_VISITORS_FILE || DEFAULT_VISITORS_FILE,
  geolocate = defaultGeolocate(),
  getUploadKey = defaultUploadKey(),
  uploadReserveBytes = envGigabytes("TYLERTUBE_UPLOAD_RESERVE_GB")
} = {}) {
  const handleUserState = createUserStateHandler(createUserStateStore(stateFile));
  const handleVisitors = createVisitorsHandler(createVisitorStore(visitorsFile, { geolocate }));
  const uploadStore = createUploadStore({ videosDir, reserveBytes: uploadReserveBytes });
  const handleUpload = createUploadHandler(uploadStore, {
    getKey: getUploadKey,
    catalogStatus: signatureCatalogStatus(videosDir)
  });

  const server = http.createServer(async (req, res) => {
    const [pathname] = (req.url || "").split("?");
    if (await handleUserState(req, res)) return;
    if (await handleVisitors(req, res)) return;
    if (await handleUpload(req, res)) return;
    if (pathname === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(req.method === "HEAD" ? undefined : "ok\n");
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found\n");
  });

  const wss = attachDriveWebSocketServer(server, videosDir);

  // drive-ws.js only claims /ws/mpeg1 and ignores other upgrades; with no Vite here, drop them.
  server.on("upgrade", (req, socket) => {
    const [pathname] = (req.url || "").split("?");
    if (pathname !== "/ws/mpeg1") socket.destroy();
  });

  // Terminating a client fires its "close" handler in drive-ws.js, which SIGKILLs its ffmpeg.
  function close() {
    return new Promise((resolve) => {
      // Stop accepting first, so a client reconnecting mid-drain can't start a new ffmpeg.
      server.close();
      server.closeAllConnections?.();
      const clients = [...wss.clients];
      let pending = clients.length;
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, SHUTDOWN_TIMEOUT_MS);
      if (pending === 0) return done();
      for (const client of clients) {
        client.once("close", () => {
          pending -= 1;
          if (pending === 0) done();
        });
        client.terminate();
      }
    });
  }

  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });

  return { server, wss, ready, close };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    // realpath: the repo is reached through the /Users/Shared/MyStreamingApp symlink.
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const port = parseInt(process.env.DRIVE_PORT || "", 10) || DEFAULT_DRIVE_PORT;
  const drive = startDriveServer({ port });

  drive.ready.then(
    (actualPort) => {
      console.log(`[drive] listening on http://127.0.0.1:${actualPort} (videos: ${DEFAULT_VIDEOS_DIR})`);
    },
    (err) => {
      console.error(`[drive] failed to listen on port ${port}: ${err.message}`);
      process.exit(1);
    }
  );

  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, async () => {
      if (shuttingDown) process.exit(1); // second signal: force exit
      shuttingDown = true;
      console.log(`[drive] ${signal}: closing ${drive.wss.clients.size} stream(s)`);
      await drive.close();
      process.exit(0);
    });
  }
}
