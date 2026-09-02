const CACHE_VERSION = "siton-shell-v2-mall";
const SHELL = [
  "/app/offline",
  "/app/assets/styles.css",
  "/app/assets/app.js",
  "/app/assets/product-library.js",
  "/app/assets/mobile-bridge.js",
  "/app/icons/logo.svg",
  "/app/icons/icon-192.png",
  "/app/icons/icon-512.png",
  "/app/manifest.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

function isStaticShell(url) {
  return url.pathname.startsWith("/app/assets/") || url.pathname.startsWith("/app/icons/") || url.pathname === "/app/manifest.webmanifest";
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/deals/") || url.pathname.includes("/payment") || url.pathname.includes("/track/") || url.pathname.includes("/recovery/")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/app/offline")));
    return;
  }
  if (isStaticShell(url)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE_VERSION).then((cache) => cache.put(request, response.clone()));
      return response;
    })));
  }
});
