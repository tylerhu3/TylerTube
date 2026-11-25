// macOS / Unix implementation of Cloudflare quick-tunnel discovery & control.
// Loaded automatically by scripts/tunnel.mjs on non-Windows platforms.
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

// `ps -axo pid=,args=` output → quick-tunnel processes ({ pid, target, metrics? }).
// Named tunnels (`tunnel run …`) have no --url and are ignored.
export function parseQuickTunnelProcesses(psOutput) {
  const found = [];
  for (const line of psOutput.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const args = m[2].split(/\s+/);
    if (!path.basename(args[0]).startsWith("cloudflared") || !args.includes("tunnel")) continue;
    const target = argValue(args, "--url");
    if (!target) continue;
    found.push({ pid: Number(m[1]), target, metrics: argValue(args, "--metrics") });
  }
  return found;
}

// `lsof -Fn` output → listening ports.
export function parseLsofPorts(lsofOutput) {
  const ports = [];
  for (const line of lsofOutput.split("\n")) {
    const m = line.match(/^n.*:(\d+)$/);
    if (m) ports.push(Number(m[1]));
  }
  return [...new Set(ports)];
}

async function listeningPorts(pid) {
  try {
    const { stdout } = await run("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"]);
    return parseLsofPorts(stdout);
  } catch {
    return [];
  }
}

// All running quick tunnels pointing at config.target, with their public URL when known.
export async function findTunnels() {
  const { stdout } = await run("ps", ["-axo", "pid=,args="]);
  const procs = parseQuickTunnelProcesses(stdout).filter((p) => targetsMatch(p.target, config.target));
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
    process.kill(pid, "SIGTERM");
    log(`stopped cloudflared pid ${pid}`);
  } catch {
    // already gone
  }
}

export const { ensureTunnel, ensureAndPublish } = createTunnelFlow({ findTunnels });

if (isMainModule(import.meta.url)) {
  await runTunnelCli({ findTunnels, ensureAndPublish });
}
