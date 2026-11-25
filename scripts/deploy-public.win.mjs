// Windows public deploy: called by scripts/deploy-public.mjs when process.platform === "win32".
//   1. npm run check, npm test, npm run build
//   2. Nginx: render Windows nginx.conf with this repo's path, copy to <NGINX_DIR>/conf/nginx.conf,
//      validate (nginx -t), and reload or start Nginx
//   3. Restart the stream server (node server/standalone.js) and wait for /healthz
//   4. Smoke test http://localhost:8080/ and /api/state
//   5. Start the tunnel keeper (node scripts/tunnel-watch.mjs) if not already running
//   6. Find or start the quick tunnel; push the Netlify redirect repo if the URL changed
// --dry-run: steps 1 and 4 only, plus report what step 6 would push (nothing is restarted or pushed).
//
// Optional environment overrides:
//   NGINX_DIR   directory containing nginx.exe (default: auto-detected via PATH or C:\nginx)
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureAndPublish, sleep } from "./tunnel.win.mjs";
import { isMainModule } from "./tunnel-common.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DRIVE_LOG = path.join(os.tmpdir(), "tylertube-drive.log");
const TUNNEL_WATCH_LOG = path.join(os.tmpdir(), "tylertube-tunnel.log");

function step(title) {
  console.log(`\n▸ ${title}`);
}

function sh(cmd, cmdArgs, { allowFail = false, cwd = ROOT, shell = false } = {}) {
  const res = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit", shell, windowsHide: true });
  if (res.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${cmdArgs.join(" ")} failed (exit ${res.status ?? res.signal})`);
  }
  return res.status === 0;
}

// Rewrite macOS-specific paths/directives in nginx.conf for Windows Nginx.
export function renderWindowsNginxConf(confText, repoRoot) {
  const normalizedRoot = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  return confText
    .replace(/^worker_processes\s+auto;/m, "worker_processes 1;")
    .replaceAll("/Users/Shared/MyStreamingApp", normalizedRoot);
}

function findNginxDir() {
  const candidates = [];
  if (process.env.NGINX_DIR) candidates.push(process.env.NGINX_DIR);

  try {
    const whereOut = execFileSync("where", ["nginx"], { encoding: "utf8", windowsHide: true }).trim();
    for (const line of whereOut.split(/\r?\n/)) {
      const exe = line.trim();
      if (exe && fs.existsSync(exe)) candidates.push(path.dirname(exe));
    }
  } catch {
    // not on PATH
  }

  candidates.push("C:\\nginx", "C:\\tools\\nginx");
  if (process.env.ProgramData) candidates.push(path.join(process.env.ProgramData, "chocolatey", "lib", "nginx", "tools"));

  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, "nginx.exe"))) return dir;
  }
  throw new Error(
    "Could not find nginx.exe. Install Nginx for Windows (e.g. C:\\nginx) and add it to PATH or set NGINX_DIR."
  );
}

function findNodeProcessesMatching(substring) {
  try {
    const psCmd =
      "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | " +
      "Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress";
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psCmd],
      { encoding: "utf8", windowsHide: true }
    ).trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const needle = substring.toLowerCase();
    return rows
      .filter((r) => r && r.ProcessId && r.ProcessId !== process.pid && String(r.CommandLine || "").toLowerCase().includes(needle))
      .map((r) => Number(r.ProcessId));
  } catch {
    return [];
  }
}

function isProcessRunning(imageName) {
  try {
    const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${imageName}`, "/NH"], {
      encoding: "utf8",
      windowsHide: true
    });
    return out.toLowerCase().includes(imageName.toLowerCase());
  } catch {
    return false;
  }
}

function killPid(pid) {
  try {
    process.kill(pid);
    return;
  } catch {
    // Fall back to taskkill
  }
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } catch {
    // already exited
  }
}

function spawnDetached(cmd, args, { cwd = ROOT, logFile } = {}) {
  let stdio = "ignore";
  let fd = null;
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fd = fs.openSync(logFile, "a");
    stdio = ["ignore", fd, fd];
  }
  const child = spawn(cmd, args, { cwd, detached: true, windowsHide: true, stdio });
  if (fd !== null) fs.closeSync(fd);
  child.unref();
  return child.pid;
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

export async function deployWin(argv = process.argv.slice(2)) {
  const dryRun = argv.includes("--dry-run");
  const skipBuild = argv.includes("--skip-build");

  const dirty = execFileSync("git", ["status", "--short"], { cwd: ROOT, encoding: "utf8", windowsHide: true }).trim();
  if (dirty) console.log(`Note: deploying with uncommitted changes:\n${dirty}`);

  if (!skipBuild) {
    step("Check, test, build");
    sh("npm", ["run", "check"], { shell: true });
    sh("npm", ["test"], { shell: true });
    sh("npm", ["run", "build"], { shell: true });
  }

  if (!dryRun) {
    step("Nginx");
    const nginxDir = findNginxDir();
    const nginxExe = path.join(nginxDir, "nginx.exe");
    const nginxConf = path.join(nginxDir, "conf", "nginx.conf");
    const repoConf = renderWindowsNginxConf(fs.readFileSync(path.join(ROOT, "nginx.conf"), "utf8"), ROOT);
    const liveConf = fs.existsSync(nginxConf) ? fs.readFileSync(nginxConf, "utf8") : "";
    if (repoConf !== liveConf) {
      if (liveConf) fs.copyFileSync(nginxConf, `${nginxConf}.bak`);
      fs.writeFileSync(nginxConf, repoConf);
      console.log(`nginx.conf changed → written to ${nginxConf} (previous saved as ${nginxConf}.bak)`);
    }
    sh(nginxExe, ["-t", "-p", nginxDir], { cwd: nginxDir });
    if (isProcessRunning("nginx.exe")) {
      sh(nginxExe, ["-s", "reload", "-p", nginxDir], { cwd: nginxDir });
      console.log("reloaded running Nginx");
    } else {
      spawnDetached(nginxExe, ["-p", nginxDir], { cwd: nginxDir });
      console.log(`started Nginx (${nginxExe})`);
    }

    step("Stream server (server/standalone.js)");
    const existingDrive = findNodeProcessesMatching("server\\standalone.js").concat(
      findNodeProcessesMatching("server/standalone.js")
    );
    for (const pid of new Set(existingDrive)) {
      killPid(pid);
    }
    const drivePid = spawnDetached(process.execPath, [path.join(ROOT, "server", "standalone.js")], {
      cwd: ROOT,
      logFile: DRIVE_LOG
    });
    console.log(`started stream server pid ${drivePid} (log: ${DRIVE_LOG})`);
    if (!(await waitFor("http://127.0.0.1:5180/healthz"))) {
      throw new Error(`stream server isn't answering on :5180 (see ${DRIVE_LOG})`);
    }
  }

  step("Smoke test");
  if (!(await waitFor("http://localhost:8080/", { ok: (r) => r.status === 200 }))) {
    throw new Error("http://localhost:8080/ isn't returning 200 (is Nginx running?)");
  }
  const stateOk = await waitFor("http://localhost:8080/api/state", { tries: 4 });
  console.log(`localhost:8080 ✓   /api/state ${stateOk ? "✓" : "✗ (sync off: check Nginx /api/ proxy + stream server)"}`);

  if (!dryRun) {
    step("Tunnel keeper (scripts/tunnel-watch.mjs)");
    const existingWatch = findNodeProcessesMatching("tunnel-watch.mjs");
    if (existingWatch.length > 0) {
      console.log(`already running (pid ${existingWatch.join(", ")})`);
    } else {
      const watchPid = spawnDetached(process.execPath, [path.join(ROOT, "scripts", "tunnel-watch.mjs")], {
        cwd: ROOT,
        logFile: TUNNEL_WATCH_LOG
      });
      console.log(`started tunnel keeper pid ${watchPid} (log: ${TUNNEL_WATCH_LOG})`);
    }
  }

  step(`Tunnel + redirect${dryRun ? " (dry run)" : ""}`);
  const { tunnel, result } = await ensureAndPublish({ dryRun });
  console.log(`\nTylerTube is at ${tunnel.url}  (redirect: ${result})`);
}

if (isMainModule(import.meta.url)) {
  deployWin().catch((err) => {
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
  });
}
