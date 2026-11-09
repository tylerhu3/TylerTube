// Dev only: Vite's watcher announces catalog changes (server/plugin.js) and the page reloads to
// pick them up. A reload would wipe the upload queue, so while the Upload page has one it's
// skipped; the queue's "Reload library" button does it when you're ready.

let hasQueue = false;

export function setUploadQueueActive(active) {
  hasQueue = Boolean(active);
}

export function handleCatalogChanged() {
  if (!hasQueue) window.location.reload();
}
