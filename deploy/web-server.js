'use strict';

/**
 * Scoot Master — serveur web statique + reverse-proxy API.
 *
 * Sert le build web de l'application mobile (Expo `export --platform web`)
 * et relaie `/api/*` vers le backend, si bien que l'app peut utiliser des
 * chemins relatifs (même origine ⇒ pas de CORS, HTTP ⇒ HTTPS transparent).
 *
 * Zéro dépendance (Node ≥ 20). Utilisé :
 *  - en aperçu/déploiement léger  : `node deploy/web-server.js`
 *  - dans le conteneur `web`      : voir mobile/Dockerfile & docker-compose.yml
 *
 * Variables :
 *   PORT        port d'écoute                  (défaut 8080)
 *   WEB_ROOT    dossier statique               (défaut ../mobile/dist)
 *   API_TARGET  URL du backend pour /api/*     (défaut http://127.0.0.1:4000)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const WEB_ROOT = path.resolve(__dirname, '..', process.env.WEB_ROOT || path.join('mobile', 'dist'));
// Render Blueprint peut injecter hostport sans schéma (ex: scoot-master-api:10000)
// On normalise pour accepter les deux formes : "http://host:port" ou "host:port".
function normalizeApiTarget(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return 'http://127.0.0.1:4000';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Si pas de schéma, on préfixe http:// (réseau privé Render)
  return `http://${trimmed}`;
}
const API_TARGET = normalizeApiTarget(process.env.API_TARGET || 'http://127.0.0.1:4000');
const API_URL = new URL(API_TARGET);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/** En-têtes de sécurité des réponses statiques.
 *
 * L'app web n'a plus besoin d'un contexte « crossOriginIsolated » (COOP/COEP) :
 * sa base SQLite tourne sur le thread principal (src/data/local/db.web.ts) et
 * non plus dans un Worker + SharedArrayBuffer. Ces en-têtes, qui cassaient
 * l'aperçu intégré (iframe non isolée ⇒ SharedArrayBuffer indisponible ⇒ page
 * blanche), sont donc supprimés.
 */
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

/** Proxy HTTP minimal : relaie méthode, en-têtes et corps vers le backend. */
function proxyApi(req, res) {
  const proxyReq = http.request(
    {
      hostname: API_URL.hostname,
      port: API_URL.port || 80,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: API_URL.host },
    },
    (proxyRes) => {
      securityHeaders(res);
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Backend indisponible.', detail: err.message }));
  });
  req.pipe(proxyReq);
}

function sendFile(res, filePath, status = 200) {
  const ext = path.extname(filePath).toLowerCase();
  securityHeaders(res);
  res.writeHead(status, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': filePath.includes('/_expo/static/') || ext === '.wasm' ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  // 1) API → backend
  if (urlPath === '/api' || urlPath.startsWith('/api/')) return proxyApi(req, res);

  // 2) Fichiers statiques
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(WEB_ROOT, safePath);
  if (filePath.startsWith(WEB_ROOT) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return sendFile(res, filePath);
  }

  // 3) Repli SPA
  const index = path.join(WEB_ROOT, 'index.html');
  if (fs.existsSync(index)) return sendFile(res, index);

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Build web introuvable — lancez « npx expo export --platform web » dans mobile/.');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🏍️  Scoot Master Web — http://0.0.0.0:${PORT}`);
  console.log(`   statique : ${WEB_ROOT}`);
  console.log(`   /api/*  → ${API_TARGET}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
