// One command for the public deploy: `npm run deploy:public [-- --dry-run] [-- --skip-build]`
//   1. npm run check, npm test, npm run build
//   2. Nginx: copy nginx.conf if it changed, nginx -t, restart
//   3. Restart the stream server (LaunchAgent com.tylertube.drive) and wait for /healthz
//   4. Smoke test http://localhost:8080/ and /api/state
//   5. Install/start the tunnel keeper (LaunchAgent com.tylertube.tunnel) if missing
//   6. Find or start the quick tunnel; push the Netlify redirect repo if the URL changed
// --dry-run: steps 1 and 4 only, plus report what step 6 would push (nothing is restarted,
// installed or pushed).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureAndPublish, sleep } from "./tunnel.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NGINX_CONF = "/opt/homebrew/etc/nginx/nginx.conf";
const UID = process.getuid();
const AGENTS = path.join(os.homedir(), "Library/LaunchAgents");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const skipBuild = args.includes("--skip-build");

function step(title) {
  console.log(`\n▸ ${title}`);
}

function sh(cmd, cmdArgs, { allowFail = false } = {}) {
  const res = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: "inherit" });
  if (res.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${cmdArgs.join(" ")} failed (exit ${res.status ?? res.signal})`);
  }
  return res.status === 0;
}

function agentLoaded(label) {
  return spawnSync("launchctl", ["print", `gui/${UID}/${label}`], { stdio: "ignore" }).status === 0;
}

async function waitFor(url, { tries = 20, ok = (r) => r.ok } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      await res.text();
      if (ok(res)) return true;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  return false;
}

async function main() {
  const dirty = execFileSync("git", ["status", "--short"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (dirty) console.log(`Note: deploying with uncommitted changes:\n${dirty}`);

  if (!skipBuild) {
    step("Check, test, build");
    sh("npm", ["run", "check"]);
    sh("npm", ["test"]);
    sh("npm", ["run", "build"]);
  }

  if (!dryRun) {
    step("Nginx");
    const repoConf = fs.readFileSync(path.join(ROOT, "nginx.conf"), "utf8");
    const liveConf = fs.existsSync(NGINX_CONF) ? fs.readFileSync(NGINX_CONF, "utf8") : "";
    if (repoConf !== liveConf) {
      if (liveConf) fs.copyFileSync(NGINX_CONF, `${NGINX_CONF}.bak`);
      fs.copyFileSync(path.join(ROOT, "nginx.conf"), NGINX_CONF);
      console.log(`nginx.conf changed → copied (previous saved as ${NGINX_CONF}.bak)`);
    }
    sh("nginx", ["-t"]);
    sh("brew", ["services", "restart", "nginx"]);

    step("Stream server (com.tylertube.drive)");
    if (agentLoaded("com.tylertube.drive")) {
      sh("launchctl", ["kickstart", "-k", `gui/${UID}/com.tylertube.drive`]);
    } else {
      console.log("LaunchAgent com.tylertube.drive isn't installed (see README); skipping restart");
    }
    if (!(await waitFor("http://127.0.0.1:5180/healthz"))) {
      throw new Error("stream server isn't answering on :5180 (see /tmp/tylertube-drive.log)");
    }
  }

  step("Smoke test");
  if (!(await waitFor("http://localhost:8080/", { ok: (r) => r.status === 200 }))) {
    throw new Error("http://localhost:8080/ isn't returning 200 (is Nginx running?)");
  }
  const stateOk = await waitFor("http://localhost:8080/api/state", { tries: 4 });
  console.log(`localhost:8080 ✓   /api/state ${stateOk ? "✓" : "✗ (sync off: check Nginx /api/ proxy + stream server)"}`);

  if (!dryRun) {
    step("Tunnel keeper (com.tylertube.tunnel)");
    if (agentLoaded("com.tylertube.tunnel")) {
      console.log("already running");
    } else {
      const plist = path.join(AGENTS, "com.tylertube.tunnel.plist");
      fs.mkdirSync(AGENTS, { recursive: true });
      fs.copyFileSync(path.join(ROOT, "scripts/launchd/com.tylertube.tunnel.plist"), plist);
      sh("launchctl", ["bootstrap", `gui/${UID}`, plist]);
      console.log(`installed ${plist}`);
    }
  }

  step(`Tunnel + redirect${dryRun ? " (dry run)" : ""}`);
  const { tunnel, result } = await ensureAndPublish({ dryRun });
  console.log(`\nTylerTube is at ${tunnel.url}  (redirect: ${result})`);
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
