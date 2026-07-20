const CACHE = "ledger-v10";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (e) => {
  // Fetch with cache:"no-cache" so a version bump pre-caches truly fresh
  // files. GitHub Pages serves assets with max-age=600, and plain
  // cache.addAll() would happily fill the new SW cache from the browser's
  // stale HTTP cache — shipping a new version label with old code.
  e.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(ASSETS.map((u) =>
        fetch(u, { cache: "no-cache" }).then((res) => {
          if (!res.ok) throw new Error("precache failed: " + u);
          return cache.put(u, res);
        })
      ))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(e.request, copy));
          return res;
        })
        .catch(() => cached);
    })
  );
});
