import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { videoCatalogPlugin } from "./server/plugin.js";
import { buildDefines } from "./server/build-info.js";

// Backend code (catalog, streaming, thumbnails, Drive WebSocket) lives in server/.
export default defineConfig({
  define: buildDefines,
  plugins: [react(), videoCatalogPlugin()],
  server: {
    port: 5173,
    host: true
  },
  build: {
    // Prevent Vite from duplicating large MP4 files from public/videos into dist/
    // Nginx serves /videos/ and /thumbnails/ directly from public/
    copyPublicDir: false
  }
});
