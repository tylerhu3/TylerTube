// Google OAuth 2.0 authentication and session management for TylerTube.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseCookies, sendJSON } from "./http-utils.js";
import "./env.js";

const DEFAULT_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOKEN_EXPIRY_BUFFER_MS = 60 * 1000; // 1 minute safety buffer

export function isAuthConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    !process.env.GOOGLE_CLIENT_ID.includes("your-google-client-id")
  );
}

export function createAuthStore(filePath) {
  let data = null;

  function load() {
    if (data) return data;
    data = { version: 1, sessions: {}, users: {} };
    try {
      if (fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (parsed && typeof parsed === "object") {
          data = {
            version: parsed.version || 1,
            sessions: parsed.sessions || {},
            users: parsed.users || {}
          };
        }
      }
    } catch (err) {
      console.error(`[auth] could not read ${filePath}: ${err.message}`);
    }
    return data;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, filePath);
    } catch (err) {
      console.error(`[auth] failed to persist auth store: ${err.message}`);
    }
  }

  function cleanExpiredSessions() {
    const store = load();
    const now = Date.now();
    let changed = false;
    for (const [sessionId, session] of Object.entries(store.sessions)) {
      if (session.expiresAt && session.expiresAt < now) {
        delete store.sessions[sessionId];
        changed = true;
      }
    }
    if (changed) save();
  }

  return {
    getSession(sessionId) {
      if (!sessionId) return null;
      cleanExpiredSessions();
      const store = load();
      return store.sessions[sessionId] || null;
    },

    getUser(userId) {
      if (!userId) return null;
      const store = load();
      return store.users[userId] || null;
    },

    saveUser(user) {
      if (!user || !user.id) return;
      const store = load();
      store.users[user.id] = {
        ...(store.users[user.id] || {}),
        ...user,
        updatedAt: Date.now()
      };
      save();
      return store.users[user.id];
    },

    createSession(userId, maxAgeMs = DEFAULT_SESSION_MAX_AGE_MS) {
      const store = load();
      const sessionId = crypto.randomUUID();
      store.sessions[sessionId] = {
        userId,
        createdAt: Date.now(),
        expiresAt: Date.now() + maxAgeMs
      };
      save();
      return sessionId;
    },

    destroySession(sessionId) {
      if (!sessionId) return;
      const store = load();
      if (store.sessions[sessionId]) {
        delete store.sessions[sessionId];
        save();
      }
    },

    getUserIdFromRequest(req) {
      const cookies = parseCookies(req);
      const sessionId = cookies.tylertube_session;
      if (!sessionId) return null;
      const session = this.getSession(sessionId);
      return session?.userId || null;
    }
  };
}

export function determineRedirectUri(req) {
  if (process.env.GOOGLE_REDIRECT_URI) {
    return process.env.GOOGLE_REDIRECT_URI;
  }
  const host =
    req.headers["x-forwarded-host"] ||
    req.headers.host ||
    "localhost:5173";
  const proto =
    req.headers["x-forwarded-proto"] ||
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}/api/auth/google/callback`;
}

export function buildGoogleAuthUrl(redirectUri, state = "") {
  const clientId = process.env.GOOGLE_CLIENT_ID || "";
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: [
      "openid",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/youtube.readonly"
    ].join(" "),
    access_type: "offline",
    prompt: "consent",
    state: state || "tylertube_auth"
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForTokens(code, redirectUri) {
  const clientId = process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${errText}`);
  }

  return await res.json();
}

export async function refreshAccessToken(refreshToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to refresh Google access token (${res.status}): ${errText}`);
  }

  return await res.json();
}

export async function fetchGoogleUserProfile(accessToken, idToken) {
  if (accessToken) {
    try {
      const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (res.ok) {
        const info = await res.json();
        return {
          id: info.sub,
          email: info.email || "",
          name: info.name || "YouTube User",
          picture: info.picture || ""
        };
      }
    } catch {
      // Fallback to id_token payload
    }
  }

  if (idToken) {
    try {
      const parts = idToken.split(".");
      if (parts[1]) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
        return {
          id: payload.sub,
          email: payload.email || "",
          name: payload.name || "YouTube User",
          picture: payload.picture || ""
        };
      }
    } catch {}
  }

  throw new Error("Could not retrieve Google user profile");
}

export async function getValidAccessToken(store, userId) {
  const user = store.getUser(userId);
  if (!user || !user.tokens) return null;

  const { access_token, refresh_token, expires_at } = user.tokens;
  const now = Date.now();

  if (access_token && expires_at && expires_at > now + TOKEN_EXPIRY_BUFFER_MS) {
    return access_token;
  }

  if (!refresh_token) {
    return access_token || null;
  }

  try {
    const refreshed = await refreshAccessToken(refresh_token);
    const newExpiresAt = Date.now() + ((refreshed.expires_in || 3600) * 1000);
    store.saveUser({
      ...user,
      tokens: {
        ...user.tokens,
        access_token: refreshed.access_token,
        expires_at: newExpiresAt
      }
    });
    return refreshed.access_token;
  } catch (err) {
    console.error(`[auth] token refresh failed for user ${userId}: ${err.message}`);
    return access_token || null;
  }
}

export function createAuthHandler(store) {
  return async function handleAuth(req, res, next) {
    const url = req.url || "";
    if (!url.startsWith("/api/auth")) {
      if (next) next();
      return false;
    }

    const [pathname, rawQuery = ""] = url.split("?");
    const params = new URLSearchParams(rawQuery);

    if (pathname === "/api/auth/me" && req.method === "GET") {
      const configured = isAuthConfigured();
      const userId = store.getUserIdFromRequest(req);
      const user = userId ? store.getUser(userId) : null;

      sendJSON(res, 200, {
        configured,
        authenticated: Boolean(user),
        user: user
          ? {
              id: user.id,
              name: user.name,
              email: user.email,
              picture: user.picture
            }
          : null
      });
      return true;
    }

    if (pathname === "/api/auth/google" && req.method === "GET") {
      const state = params.get("redirect") || "youtube";
      if (!isAuthConfigured()) {
        res.writeHead(302, {
          Location: `/?page=${encodeURIComponent(state)}&auth_error=${encodeURIComponent(
            "Google OAuth is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env"
          )}`
        });
        res.end();
        return true;
      }

      const redirectUri = determineRedirectUri(req);
      const authUrl = buildGoogleAuthUrl(redirectUri, state);

      res.writeHead(302, { Location: authUrl });
      res.end();
      return true;
    }

    if (pathname === "/api/auth/google/callback" && req.method === "GET") {
      const code = params.get("code");
      const error = params.get("error");
      const state = params.get("state") || "youtube";

      if (error || !code) {
        res.writeHead(302, {
          Location: `/?page=${encodeURIComponent(state)}&auth_error=${encodeURIComponent(error || "Authorization cancelled")}`
        });
        res.end();
        return true;
      }

      try {
        const redirectUri = determineRedirectUri(req);
        const tokens = await exchangeCodeForTokens(code, redirectUri);
        const profile = await fetchGoogleUserProfile(tokens.access_token, tokens.id_token);

        const expiresAt = Date.now() + ((tokens.expires_in || 3600) * 1000);
        store.saveUser({
          id: profile.id,
          name: profile.name,
          email: profile.email,
          picture: profile.picture,
          tokens: {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: expiresAt
          }
        });

        const sessionId = store.createSession(profile.id);
        const isSecure = req.headers["x-forwarded-proto"] === "https";
        const cookieHeader = [
          `tylertube_session=${sessionId}`,
          "Path=/",
          "HttpOnly",
          "SameSite=Lax",
          `Max-Age=${Math.floor(DEFAULT_SESSION_MAX_AGE_MS / 1000)}`,
          isSecure ? "Secure" : ""
        ].filter(Boolean).join("; ");

        const allowedPages = new Set(["home", "history", "favorites", "youtube", "shorts", "upload"]);
        const destinationPage = allowedPages.has(state) ? state : "youtube";
        res.writeHead(302, {
          "Set-Cookie": cookieHeader,
          Location: `/?page=${destinationPage}&auth=success`
        });
        res.end();
      } catch (err) {
        console.error(`[auth] Google OAuth callback error: ${err.message}`);
        const userMsg = err.message?.includes("invalid_client")
          ? "Invalid Google Client ID or Secret. Please verify your credentials in .env."
          : (err.message || "Failed to complete login");
        res.writeHead(302, {
          Location: `/?page=${encodeURIComponent(state)}&auth_error=${encodeURIComponent(userMsg)}`
        });
        res.end();
      }
      return true;
    }

    if (pathname === "/api/auth/logout" && req.method === "POST") {
      const cookies = parseCookies(req);
      if (cookies.tylertube_session) {
        store.destroySession(cookies.tylertube_session);
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": "tylertube_session=; Path=/; HttpOnly; Max-Age=0"
      });
      res.end(JSON.stringify({ success: true }));
      return true;
    }

    sendJSON(res, 404, { error: "Not found" });
    return true;
  };
}
