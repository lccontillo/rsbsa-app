/* RSBSA Certification Manager — service worker (Offline Mode / PWA).
 * - App shell (HTML/CSS/JS/icons) is cached so the app opens offline.
 * - GET /api responses are cached network-first, so pages a secretary has
 *   already viewed (dashboard, queues, masterlist, archive) stay readable
 *   offline. Downloads/exports are never cached.
 * - Non-GET requests are never handled here: the app itself queues them in
 *   its offline outbox (see app.js) and syncs when the connection returns.
 */
const SHELL_CACHE = "rsbsa-shell-v5";
const API_CACHE = "rsbsa-api-v1";
const SHELL = [
  "/",
  "/static/style.css",
  "/static/app.js",
  "/static/office-logo.png",
  "/static/jsQR.js",
  "/static/manifest.webmanifest",
  "/static/icons/icon-192.png",
  "/static/icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => ![SHELL_CACHE, API_CACHE].includes(k))
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/"))
    );
    return;
  }

  if (e.request.method !== "GET") {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: "offline", offline: true }), {
          status: 503, headers: { "Content-Type": "application/json" },
        }))
    );
    return;
  }

  if (url.pathname === "/api/auth/me") return; // identity: network only

  if (url.pathname.startsWith("/api/")) {
    if (/\/(download|export|backup)(\/|$)/.test(url.pathname)) return; // files: network only
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(API_CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then((hit) => hit ||
          new Response(JSON.stringify({ error: "You are offline and this page has no saved copy yet." }), {
            status: 503, headers: { "Content-Type": "application/json" },
          })))
    );
    return;
  }

  if (url.pathname.startsWith("/static/")) {
    e.respondWith(
      caches.match(e.request).then((hit) => {
        const net = fetch(e.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
});
