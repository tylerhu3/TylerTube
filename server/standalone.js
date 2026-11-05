// Standalone Drive server for production: `npm run server` (no Vite).
// Serves the /ws/mpeg1 WebSocket (server/drive-ws.js) on 127.0.0.1:$DRIVE_PORT (default 5180);
// Nginx proxies /ws/mpeg1 here. GET /healthz → 200 for smoke tests; everything else → 404.
// In dev, the Vite plugin (server/plugin.js) attaches the same handler to :5173 instead.
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { attachDriveWebSocketServer } from "./drive-ws.js";

export const DEFAULT_DRIVE_PORT = 5180;
const SHUTDOWN_TIMEOUT_MS = 2000;

// Relative to this file, not process.cwd(). (resolveLocalVideoFile's basename fallback still uses
// cwd; npm and the launchd plist both run from the repo root.)
const DEFAULT_VIDEOS_DIR = fileURLToPath(new URL("../public/videos", import.meta.url));

export function startDriveServer({
  port = DEFAULT_DRIVE_PORT,
  host = "127.0.0.1",
  videosDir = DEFAULT_VIDEOS_DIR
} = {}) {
  const server = http.createServer((req, res) => {
    const [pathname] = (req.url || "").split("?");
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
