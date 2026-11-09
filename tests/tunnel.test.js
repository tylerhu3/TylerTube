// Pure helpers of scripts/tunnel.mjs (quick-tunnel discovery + Netlify redirect files).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLsofPorts,
  parsePublishedUrl,
  parseQuickTunnelProcesses,
  renderRedirects,
  targetsMatch
} from "../scripts/tunnel.mjs";

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
