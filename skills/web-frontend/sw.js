// Network-first offline service worker for a small installable web app.
// Edit only APP, VERSION and PRECACHE. Paths resolve relative to this file's scope.
// Register from the page: navigator.serviceWorker?.register("sw.js");
const APP = "my-app";        // unique per app sharing the origin
const VERSION = "1";         // bump to drop stale caches
const PRECACHE = ["./", "index.html", "manifest.json", "icon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];

const CACHE = `${APP}-v${VERSION}`;
const scoped = path => new URL(path, self.registration.scope).href;

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => Promise.all(PRECACHE.map(async path => {
    try {
      const response = await fetch(scoped(path), {cache: "no-cache"});
      if (response.ok) await cache.put(scoped(path), response);
    } catch (err) { console.warn(`${APP}: precache failed for ${path}`, err); }
  }))));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith(`${APP}-v`) && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const {request} = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)));
    }
    return response;
  }).catch(async () => (await caches.match(request))
    ?? (request.mode === "navigate" ? caches.match(scoped("./")) : Response.error())));
});
