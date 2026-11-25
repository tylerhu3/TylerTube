// Windows implementation of Cloudflare quick-tunnel discovery & control.
// Loaded automatically by scripts/tunnel.mjs when process.platform === "win32".
import path from "node:path";
import {
  argValue,
  config,
  createTunnelFlow,
  hasUnpushedCommits,
  isMainModule,
  log,
  metricsHostname,
  metricsReady,
  parsePublishedUrl,
  publishRedirect,
  readPublishedUrl,
  renderIndexHtml,
  renderRedirects,
  run,
  runTunnelCli,
  sleep,
  splitCommandLine,
  startTunnel,
  targetsMatch,
  waitForPublic
} from "./tunnel-common.mjs";

export {
  config,
  hasUnpushedCommits,
  log,
  metricsReady,
  parsePublishedUrl,
  publishRedirect,
  readPublishedUrl,
  renderIndexHtml,
  renderRedirects,
  sleep,
  startTunnel,
  targetsMatch,
  waitForPublic
};

// Parse JSON output of:
//   Get-CimInstance Win32_Process -Filter "Name like 'cloudflared%'" |
//     Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress
// Accepts either a single object, an array, or empty output.
export function parseWindowsTunnelProcesses(jsonText) {
  const trimmed = (jsonText || "").trim();
  if (!trimmed) return [];
  let rows;
  try {
    const parsed = JSON.parse(trimmed);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }

  const found = [];
  for (const row of rows) {
    if (!row || !row.ProcessId || !row.CommandLine) continue;
    const args = splitCommandLine(String(row.CommandLine));
    if (!args.length) continue;
    const exe = path.win32.basename(args[0]).toLowerCase();
    if (!exe.startsWith("cloudflared") || !args.includes("tunnel")) continue;
    const target = argValue(args, "--url");
    if (!target) continue;
    found.push({ pid: Number(row.ProcessId), target, metrics: argValue(args, "--metrics") });
  }
  return found;
}

// `netstat -ano -p TCP` output → listening TCP ports belonging to `pid`.
export function parseNetstatPorts(netstatOutput, pid) {
  const targetPid = String(pid);
  const ports = [];
  for (const line of (netstatOutput || "").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    // Expected: TCP  127.0.0.1:20250  0.0.0.0:0  LISTENING  12345
    if (parts.length < 5) continue;
    if (parts[0].toUpperCase() !== "TCP") continue;
    if (parts[3].toUpperCase() !== "LISTENING") continue;
    if (parts[4] !== targetPid) continue;
    const m = parts[1].match(/:(\d+)$/);
    if (m) ports.push(Number(m[1]));
  }
  return [...new Set(ports)];
}

async function listeningPorts(pid) {
  try {
    const { stdout } = await run("netstat", ["-ano", "-p", "TCP"], { windowsHide: true });
    return parseNetstatPorts(stdout, pid);
  } catch {
    return [];
  }
}

// All running quick tunnels pointing at config.target, with their public URL when known.
export async function findTunnels() {
  let stdout = "";
  try {
    const psCmd =
      "Get-CimInstance Win32_Process -Filter \"Name like 'cloudflared%'\" | " +
      "Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress";
    ({ stdout } = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psCmd],
      { windowsHide: true }
    ));
  } catch {
    return [];
  }

  const procs = parseWindowsTunnelProcesses(stdout).filter((p) => targetsMatch(p.target, config.target));
  const tunnels = [];
  for (const proc of procs) {
    const candidates = proc.metrics
      ? [proc.metrics.includes(":") ? proc.metrics : `127.0.0.1:${proc.metrics}`]
      : (await listeningPorts(proc.pid)).map((port) => `127.0.0.1:${port}`);
    let hostname = null;
    let metrics = null;
    for (const addr of candidates) {
      hostname = await metricsHostname(addr);
      if (hostname) {
        metrics = addr;
        break;
      }
    }
    tunnels.push({ ...proc, metrics, url: hostname ? `https://${hostname}` : null });
  }
  return tunnels;
}

export async function stopTunnel(pid) {
  try {
    process.kill(pid);
    log(`stopped cloudflared pid ${pid}`);
    return;
  } catch {
    // Fall back to taskkill if process.kill couldn't terminate it
  }
  try {
    await run("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    log(`stopped cloudflared pid ${pid}`);
  } catch {
    // already gone
  }
}

export const { ensureTunnel, ensureAndPublish } = createTunnelFlow({ findTunnels });

if (isMainModule(import.meta.url)) {
  await runTunnelCli({ findTunnels, ensureAndPublish });
}
