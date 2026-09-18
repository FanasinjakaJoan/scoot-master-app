/*
 * Scoot Master — service worker de l'application web.
 *
 * Rôle :
 *  - rendre l'application **installable** (PWA) : icône sur l'écran d'accueil
 *    du téléphone, application de bureau sur PC, lancement en fenêtre dédiée ;
 *  - servir le shell applicatif hors ligne (l'app est offline-first : la base
 *    SQLite locale tourne déjà dans le navigateur via sql.js).
 *
 * Stratégie :
 *  - navigations            → réseau d'abord, repli sur le shell en cache ;
 *  - `/_expo/static/` + assets immuables (hashés) → cache d'abord ;
 *  - `/api/*`               → JAMAIS mis en cache (données métier, sync) ;
 *  - tout le reste          → réseau d'abord, cache en secours.
 */

const CACHE = 'scoot-master-v1';
const SHELL = '/';

self.addEventListener('install', (event) => {
  // Le SW devient actif immédiatement (pas d'attente d'une ancienne version).
  event.waitUntil(caches.open(CACHE).then((c) => c.add(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isCacheableAsset = (pathname) =>
  pathname.startsWith('/_expo/static/') ||
  /\.(png|jpe?g|svg|webp|ico|woff2?|ttf|css|wasm)$/i.test(pathname);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // L'API reste toujours en direct : la synchronisation ne doit jamais lire un cache.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  // Navigation (document) : réseau d'abord, repli hors ligne sur le shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(SHELL, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(SHELL).then((hit) => hit || Response.error()))
    );
    return;
  }

  // Ressources statiques : cache d'abord pour les fichiers immuables (hashés).
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          if (res && res.ok && isCacheableAsset(url.pathname)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
    })
  );
});
