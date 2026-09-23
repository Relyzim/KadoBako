/* KadoBako — service worker
   Incrémenter APP_VERSION à chaque modification visible de l'app :
   c'est ce qui déclenche la mise à jour chez les utilisateurs. */
const APP_VERSION = "v1.04";
const SHELL_CACHE = `flipdex-shell-${APP_VERSION}`;
const RUNTIME_CACHE = "flipdex-runtime";
const RUNTIME_MAX = 400;

const SHELL_ASSETS = [
  "./", "./index.html", "./styles.css", "./app.js", "./manifest.json",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png", "./icons/apple-touch-icon-167.png", "./icons/apple-touch-icon-152.png",
  "./icons/apple-touch-icon-120.png", "./icons/favicon-32.png", "./icons/favicon-16.png",
  "./apple-touch-icon.png", "./favicon.ico"
];

self.addEventListener("install", (event) => {
  // cache:"reload" contourne le cache HTTP pour garantir des fichiers à jour
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_ASSETS.map((u) => new Request(u, { cache: "reload" }))))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("flipdex-shell-") && k !== SHELL_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

async function trimRuntime() {
  const cache = await caches.open(RUNTIME_CACHE);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - RUNTIME_MAX; i++) await cache.delete(keys[i]);
}

// Catalogue et prix : toujours le réseau d'abord (prix frais), cache seulement hors-ligne
async function networkFirst(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) { await cache.put(req, res.clone()); trimRuntime(); }
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

// Polices : cache d'abord (fichiers immuables). Les réponses opaques ne sont jamais mises en cache
async function cacheFirst(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) { await cache.put(req, res.clone()); trimRuntime(); }
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (req.mode === "navigate") {
      event.respondWith(caches.match("./index.html").then((r) => r || fetch(req)));
      return;
    }
    event.respondWith(caches.match(req, { ignoreSearch: true }).then((r) => r || fetch(req)));
    return;
  }
  if (url.hostname === "api.tcgdex.net") { event.respondWith(networkFirst(req)); return; }
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") { event.respondWith(cacheFirst(req)); return; }
  // Le reste (images TCGdex…) passe directement par le réseau et le cache HTTP du navigateur
});
