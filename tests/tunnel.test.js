// Pure helpers of scripts/tunnel.mjs (quick-tunnel discovery + Netlify redirect files).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLsofPorts,
  parseNetstatPorts,
  parsePublishedUrl,
  parseQuickTunnelProcesses,
  parseWindowsTunnelProcesses,
  renderRedirects,
  targetsMatch
} from "../scripts/tunnel.mjs";
import { renderWindowsNginxConf } from "../scripts/deploy-public.win.mjs";

test("targetsMatch: loopback aliases on the same port match", () => {
  assert.ok(targetsMatch("http://localhost:8080", "http://127.0.0.1:8080"));
  assert.ok(targetsMatch("http://localhost:8080/", "http://localhost:8080"));
  assert.ok(!targetsMatch("http://localhost:8080", "http://localhost:8742"));
  assert.ok(!targetsMatch("http://example.com:8080", "http://localhost:8080"));
  assert.ok(!targetsMatch("garbage", "http://localhost:8080"));
});

test("parseQuickTunnelProcesses: quick tunnels only, with --url and --metrics", () => {
  const ps = [
    "  49675 cloudflared tunnel --url http://localhost:8080",
    "  83078 /opt/homebrew/bin/cloudflared tunnel run --token-file /x/token",
    "  93876 cloudflared tunnel --url=http://127.0.0.1:8742 --metrics 127.0.0.1:20250",
    "  111 node server.js --url http://localhost:8080",
    ""
  ].join("\n");
  assert.deepEqual(parseQuickTunnelProcesses(ps), [
    { pid: 49675, target: "http://localhost:8080", metrics: undefined },
    { pid: 93876, target: "http://127.0.0.1:8742", metrics: "127.0.0.1:20250" }
  ]);
});

test("parseLsofPorts", () => {
  assert.deepEqual(parseLsofPorts("p49675\nf10\nn127.0.0.1:20243\nf11\nn[::1]:20243\n"), [20243]);
  assert.deepEqual(parseLsofPorts(""), []);
});

test("renderRedirects round-trips through parsePublishedUrl and forces a 302", () => {
  const url = "https://a-b-c.trycloudflare.com";
  const text = renderRedirects(url);
  assert.match(text, /^\/\*\s+https:\/\/a-b-c\.trycloudflare\.com\/:splat\s+302!$/m);
  assert.equal(parsePublishedUrl(text), url);
  assert.equal(parsePublishedUrl("# nothing"), null);
});

test("parseWindowsTunnelProcesses: parses PowerShell CIM JSON (array and single object)", () => {
  const arr = JSON.stringify([
    {
      ProcessId: 4210,
      CommandLine: "\"C:\\Program Files\\cloudflared\\cloudflared.exe\" tunnel --url http://localhost:8080 --metrics 127.0.0.1:20250"
    },
    {
      ProcessId: 4211,
      CommandLine: "cloudflared.exe tunnel run --token abc"
    }
  ]);
  assert.deepEqual(parseWindowsTunnelProcesses(arr), [
    { pid: 4210, target: "http://localhost:8080", metrics: "127.0.0.1:20250" }
  ]);

  const single = JSON.stringify({
    ProcessId: 9001,
    CommandLine: "cloudflared tunnel --url=http://127.0.0.1:8080"
  });
  assert.deepEqual(parseWindowsTunnelProcesses(single), [
    { pid: 9001, target: "http://127.0.0.1:8080", metrics: undefined }
  ]);
  assert.deepEqual(parseWindowsTunnelProcesses(""), []);
});

test("parseNetstatPorts: extracts listening TCP ports for a specific PID", () => {
  const out = [
    "Active Connections",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    127.0.0.1:20250        0.0.0.0:0              LISTENING       4210",
    "  TCP    [::1]:20250            [::]:0                 LISTENING       4210",
    "  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       9999",
    "  TCP    127.0.0.1:20250        127.0.0.1:51234        ESTABLISHED     4210",
    ""
  ].join("\r\n");
  assert.deepEqual(parseNetstatPorts(out, 4210), [20250]);
  assert.deepEqual(parseNetstatPorts(out, 9999), [8080]);
  assert.deepEqual(parseNetstatPorts("", 4210), []);
});

test("renderWindowsNginxConf: rewrites worker_processes and repo root path", () => {
  const sample = [
    "worker_processes auto;",
    "root   /Users/Shared/MyStreamingApp/dist;",
    "alias  /Users/Shared/MyStreamingApp/public/videos/;"
  ].join("\n");
  const rendered = renderWindowsNginxConf(sample, "C:\\Users\\Tyler\\Projects\\TylerTube\\");
  assert.match(rendered, /^worker_processes 1;/m);
  assert.ok(rendered.includes("root   C:/Users/Tyler/Projects/TylerTube/dist;"));
  assert.ok(rendered.includes("alias  C:/Users/Tyler/Projects/TylerTube/public/videos/;"));
});
