// Loads environment variables from .env file into process.env if present.
import fs from "node:fs";
import path from "node:path";

let loaded = false;

export function loadEnv(envPath = path.resolve(process.cwd(), ".env")) {
  if (loaded) return;
  loaded = true;

  if (!fs.existsSync(envPath)) {
    return;
  }

  if (typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(envPath);
      return;
    } catch {
      // Fallback to manual parser below if loadEnvFile has format parsing quirks
    }
  }

  try {
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        // Remove surrounding quotes if present
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (key && process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    }
  } catch (err) {
    console.error(`[env] failed to load ${envPath}: ${err.message}`);
  }
}

// Auto-load on import
loadEnv();
