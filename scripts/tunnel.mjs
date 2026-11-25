// OS dispatcher for Cloudflare quick tunnel + Netlify redirect.
// Automatically loads scripts/tunnel.win.mjs on Windows or scripts/tunnel.mac.mjs on macOS/Unix.
//
// CLI:
//   node scripts/tunnel.mjs status            show tunnels for the target + what's published
//   node scripts/tunnel.mjs ensure [--dry-run] find/start the tunnel, publish if it changed
import { isMainModule, runTunnelCli } from "./tunnel-common.mjs";

const impl = await import(process.platform === "win32" ? "./tunnel.win.mjs" : "./tunnel.mac.mjs");

export const {
  config,
  ensureAndPublish,
  ensureTunnel,
  findTunnels,
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
  stopTunnel,
  targetsMatch,
  waitForPublic
} = impl;

// Re-export both OS parsers so unit tests can verify macOS and Windows parsing on any platform.
export { parseLsofPorts, parseQuickTunnelProcesses } from "./tunnel.mac.mjs";
export { parseNetstatPorts, parseWindowsTunnelProcesses } from "./tunnel.win.mjs";

if (isMainModule(import.meta.url)) {
  await runTunnelCli({ findTunnels, ensureAndPublish });
}
