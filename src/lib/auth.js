// Client-side authentication helpers for Google OAuth and TylerTube session state.

export async function fetchAuthStatus() {
  try {
    const res = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (!res.ok) {
      return { configured: false, authenticated: false, user: null };
    }
    const data = await res.json();
    return {
      configured: Boolean(data.configured),
      authenticated: Boolean(data.authenticated),
      user: data.user || null
    };
  } catch (err) {
    console.warn("[auth] failed to fetch auth status:", err.message);
    return { configured: false, authenticated: false, user: null };
  }
}

export async function logoutUser() {
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin"
    });
  } catch (err) {
    console.warn("[auth] logout request failed:", err.message);
  }
}

export function getGoogleLoginUrl(redirectPage = "youtube") {
  return `/api/auth/google?redirect=${encodeURIComponent(redirectPage)}`;
}
