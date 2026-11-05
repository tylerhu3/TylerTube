// Version/build stamps injected via Vite `define` (read by src/version.js).
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf-8")
);

const gitHash = (() => {
  try {
    return execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"]
    })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
})();

const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const buildCode = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
  now.getDate()
)}.${pad(now.getHours())}${pad(now.getMinutes())}`;
const appVersion = `v${pkg.version || "1.0.0"} (build ${buildCode} · ${gitHash})`;
const buildTimeStr = now.toLocaleString("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true
});

export const buildDefines = {
  __APP_VERSION__: JSON.stringify(appVersion),
  __BUILD_TIME__: JSON.stringify(buildTimeStr),
  __BUILD_CODE__: JSON.stringify(buildCode),
  __GIT_COMMIT__: JSON.stringify(gitHash)
};
