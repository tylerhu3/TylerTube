// Long-running keeper (LaunchAgent com.tylertube.tunnel, scripts/launchd/). Every 30 s:
//   - Tunnel: make sure a quick tunnel for Nginx (:8080) is running and the Netlify redirect
//     repo points at its current URL (scripts/tunnel.mjs). If cloudflared stays disconnected
//     for ~2 min it's replaced, which yields a new URL that then gets published.
//   - Catalog: if public/videos/ differs from what dist/ was built from (server/video-signature.js)
//     and has been still for a minute, run `npm run build` so new videos show up. Nginx serves
//     dist/ directly, so nothing needs restarting. Note: the build ships whatever code is in the
//     working tree at that moment. Set AUTO_REBUILD=0 to turn this off.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  computeVideoSignature,
  readRecordedSignature,
  shouldRebuild
} from "../server/video-signature.js";
import { ensureAndPublish, log, metricsReady, sleep, stopTunnel } from "./tunnel.mjs";

const INTERVAL_MS = 30_000;
const MAX_NOT_READY_TICKS = 4;
const STABLE_MS = 60_000;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VIDEOS_DIR = fileURLToPath(new URL("../public/videos", import.meta.url));
const AUTO_REBUILD = process.env.AUTO_REBUILD !== "0";

let notReady = 0;
// cloudflared is detached and keeps running after we exit; the next watcher adopts it.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));

async function tunnelTick() {
  const { tunnel } = await ensureAndPublish({ quiet: true });
  if (tunnel.metrics && !(await metricsReady(tunnel.metrics))) {
    notReady += 1;
    log(`tunnel not connected (${notReady}/${MAX_NOT_READY_TICKS})`);
    if (notReady >= MAX_NOT_READY_TICKS) {
      await stopTunnel(tunnel.pid);
      notReady = 0;
    }
  } else {
    notReady = 0;
  }
}

const catalog = { seen: null, failed: null, building: false };

function runBuild() {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", "build"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk) => {
      output = (output + chunk).slice(-4000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => resolve({ ok: false, output: err.message }));
    child.on("close", (code) => resolve({ ok: code === 0, output }));
  });
}

// Runs the build in the background so tunnel ticks continue meanwhile (new videos' thumbnails
// can take a while).
function catalogTick() {
  if (catalog.building) return;
  const { signature: current, files } = computeVideoSignature(VIDEOS_DIR);
  const now = Date.now();
  if (catalog.seen?.signature !== current) catalog.seen = { signature: current, since: now };
  const built = readRecordedSignature();
  if (!built) return; // never built (or built before signatures existed): leave it to a deploy
  if (!shouldRebuild({ current, built, seen: catalog.seen, failed: catalog.failed, now, stableMs: STABLE_MS })) {
    return;
  }

  catalog.building = true;
  log(`public/videos changed (${files} files); rebuilding`);
  runBuild().then(({ ok, output }) => {
    catalog.building = false;
    if (ok) {
      catalog.failed = null;
      log("rebuild done; new catalog is live");
    } else {
      // Don't retry the same folder state every 30 s; any further change retries.
      catalog.failed = current;
      log(`rebuild failed:\n${output.trim()}`);
    }
  });
}

log(`watcher started (auto-rebuild ${AUTO_REBUILD ? "on" : "off"})`);
for (;;) {
  try {
    await tunnelTick();
  } catch (err) {
    log(`tunnel error: ${err.stderr?.trim() || err.message}`);
  }
  if (AUTO_REBUILD) {
    try {
      catalogTick();
    } catch (err) {
      log(`catalog error: ${err.message}`);
    }
  }
  await sleep(INTERVAL_MS);
}
