// Cache-first service worker so PennyLog opens and works with no connection (PWA / Windows app / browser).
// Bump CACHE whenever you change any file, otherwise players keep seeing the old copy.
const CACHE = "pennylog-v1";
const FILES = [
  "./",
  "app.css",
  "app.js",
  "auth.css",
  "files.js",
  "format.js",
  "icon-1024.png",
  "icon-192.png",
  "icon-512-maskable.png",
  "icon-512.png",
  "index.css",
  "index.html",
  "insights.js",
  "inter-latin-400-normal.woff2",
  "inter-latin-500-normal.woff2",
  "inter-latin-600-normal.woff2",
  "inter-latin-700-normal.woff2",
  "inter-latin-800-normal.woff2",
  "jetbrains-mono-latin-400-normal.woff2",
  "jetbrains-mono-latin-500-normal.woff2",
  "jetbrains-mono-latin-600-normal.woff2",
  "logic.js",
  "main.css",
  "manifest.webmanifest",
  "parser.js",
  "privacy.html",
  "read-excel-file.min.js",
  "store.js",
  "theme.js"
];
self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
});
