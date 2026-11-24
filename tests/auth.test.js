import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isAuthConfigured,
  createAuthStore,
  createAuthHandler,
  buildGoogleAuthUrl,
  determineRedirectUri
} from "../server/auth.js";

test("isAuthConfigured detects missing vs valid credentials", () => {
  const origId = process.env.GOOGLE_CLIENT_ID;
  const origSecret = process.env.GOOGLE_CLIENT_SECRET;

  try {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    assert.equal(isAuthConfigured(), false);

    process.env.GOOGLE_CLIENT_ID = "your-google-client-id.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "your-google-client-secret";
    assert.equal(isAuthConfigured(), false);

    process.env.GOOGLE_CLIENT_ID = "123456789.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "GOCSPX-secretkey";
    assert.equal(isAuthConfigured(), true);
  } finally {
    if (origId) process.env.GOOGLE_CLIENT_ID = origId;
    else delete process.env.GOOGLE_CLIENT_ID;
    if (origSecret) process.env.GOOGLE_CLIENT_SECRET = origSecret;
    else delete process.env.GOOGLE_CLIENT_SECRET;
  }
});

test("determineRedirectUri parses proto and host", () => {
  const req = {
    headers: {
      host: "localhost:5173"
    }
  };
  assert.equal(determineRedirectUri(req), "http://localhost:5173/api/auth/google/callback");

  const reqForwarded = {
    headers: {
      "x-forwarded-host": "tube.example.com",
      "x-forwarded-proto": "https"
    }
  };
  assert.equal(determineRedirectUri(reqForwarded), "https://tube.example.com/api/auth/google/callback");
});

test("buildGoogleAuthUrl constructs valid Google OAuth link", () => {
  const origId = process.env.GOOGLE_CLIENT_ID;
  try {
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    const url = buildGoogleAuthUrl("http://localhost:5173/api/auth/google/callback", "shorts");
    assert.ok(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?"));
    assert.ok(url.includes("client_id=test-client-id"));
    assert.ok(url.includes("redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Fapi%2Fauth%2Fgoogle%2Fcallback"));
    assert.ok(url.includes("state=shorts"));
    assert.ok(url.includes("access_type=offline"));
  } finally {
    if (origId) process.env.GOOGLE_CLIENT_ID = origId;
    else delete process.env.GOOGLE_CLIENT_ID;
  }
});

test("createAuthStore creates and retrieves sessions and users", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tylertube-auth-test-"));
  const authFile = path.join(tmpDir, "auth.json");

  try {
    const store = createAuthStore(authFile);

    // Save a user
    store.saveUser({
      id: "google_12345",
      name: "Tyler Tester",
      email: "tyler@example.com",
      tokens: { access_token: "mock-token", refresh_token: "mock-refresh" }
    });

    const user = store.getUser("google_12345");
    assert.equal(user.name, "Tyler Tester");
    assert.equal(user.email, "tyler@example.com");

    // Session management
    const sessionId = store.createSession("google_12345", 10000);
    assert.ok(sessionId);

    const session = store.getSession(sessionId);
    assert.equal(session.userId, "google_12345");

    // Retrieve user ID from request cookie
    const reqWithCookie = {
      headers: {
        cookie: `tylertube_session=${sessionId}`
      }
    };
    assert.equal(store.getUserIdFromRequest(reqWithCookie), "google_12345");

    // Destroy session
    store.destroySession(sessionId);
    assert.equal(store.getSession(sessionId), null);
    assert.equal(store.getUserIdFromRequest(reqWithCookie), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("createAuthHandler: /api/auth/me returns status and /api/auth/google redirects on unconfigured", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tylertube-auth-handler-"));
  const authFile = path.join(tmpDir, "auth.json");

  try {
    const store = createAuthStore(authFile);
    const handler = createAuthHandler(store);

    // Test /api/auth/me
    let status = 0;
    let body = "";
    const reqMe = { url: "/api/auth/me", method: "GET", headers: {} };
    const resMe = {
      writeHead(s) { status = s; },
      end(b) { body = b; }
    };

    assert.equal(await handler(reqMe, resMe), true);
    assert.equal(status, 200);
    const meData = JSON.parse(body);
    assert.equal(typeof meData.configured, "boolean");
    assert.equal(meData.authenticated, false);

    // Test /api/auth/google when not configured -> redirect with auth_error
    const origId = process.env.GOOGLE_CLIENT_ID;
    const origSecret = process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;

    let redirStatus = 0;
    let redirHeaders = {};
    const reqLogin = { url: "/api/auth/google?redirect=youtube", method: "GET", headers: { host: "localhost:5173" } };
    const resLogin = {
      writeHead(s, h) { redirStatus = s; redirHeaders = h; },
      end() {}
    };

    assert.equal(await handler(reqLogin, resLogin), true);
    assert.equal(redirStatus, 302);
    assert.ok(redirHeaders.Location.includes("auth_error="));

    if (origId) process.env.GOOGLE_CLIENT_ID = origId;
    if (origSecret) process.env.GOOGLE_CLIENT_SECRET = origSecret;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
