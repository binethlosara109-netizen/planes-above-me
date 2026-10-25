// Service worker: makes the site installable and lets it open even offline.
// - The app's own files: from the network, with a cached copy for offline use.
// - Live data (/api/*, other websites): always from the network, never cached.
// Bump VERSION when the list of files changes.

const VERSION = "v1";
const CACHE = "planes-" + VERSION;
const SHELL = [
  "/", "/style.css", "/manifest.webmanifest",
  "/js/main.js", "/js/geo.js", "/js/format.js", "/js/i18n.js", "/js/settings.js", "/js/api.js",
  "/js/mapview.js", "/js/spotter.js", "/js/sky.js", "/js/share.js",
  "/icons/icon.svg", "/icons/icon-192.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  // Network first, so every update shows up at once and old and new files never mix;
  // the cached copy is used only when offline.
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
    return res;
  }).catch(async () => (await caches.match(e.request)) || (e.request.mode === "navigate" ? caches.match("/") : Response.error())));
});
