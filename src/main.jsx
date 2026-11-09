import React from "react";
import { createRoot } from "react-dom/client";
import App, { syncStore } from "./App";
import "./styles/index.css";
import { handleCatalogChanged } from "./lib/uploadActivity";

// Dev: new or removed videos (server/plugin.js) → reload, unless an upload queue is open.
if (import.meta.hot) {
  import.meta.hot.on("tylertube:catalog-changed", handleCatalogChanged);
}

// Pull the server copy of progress/favorites/prefs into localStorage first, so App's lazy
// initializers see it (a new tunnel URL starts with empty storage). Never rejects; times out.
syncStore.initialSync().then(() => {
  createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});

