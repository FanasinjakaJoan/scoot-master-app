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
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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
  '.apk': 'application/vnd.android.package-archive',
};

/** Dossier où déposer l'APK pour le distribuer depuis ce serveur (git-ignoré). */
const APK_DIR = path.resolve(__dirname, process.env.APK_DIR || 'apk');
const APK_FILE = path.join(APK_DIR, process.env.APK_FILE || 'scoot-master-latest.apk');
/** Repli si aucun APK n'est hébergé ici : dernière Release GitHub. */
const APK_REMOTE_URL =
  process.env.APK_URL ||
  'https://github.com/FanasinjakaJoan/scoot-master-app/releases/latest/download/scoot-master-latest.apk';
const ACTIONS_URL =
  'https://github.com/FanasinjakaJoan/scoot-master-app/actions/workflows/apk.yml';

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

/**
 * Page « Installer Scoot Master » (`GET /install`) : un seul raccourci pour
 * obtenir l'application, quel que soit l'appareil — APK Android, application de
 * bureau (PWA) ou écran d'accueil iOS.
 */
function sendInstallPage(req, res) {
  const hasApk = fs.existsSync(APK_FILE);
  const apkHref = hasApk ? `/apk/${path.basename(APK_FILE)}` : APK_REMOTE_URL;
  const sizeMb = hasApk ? ` — ${(fs.statSync(APK_FILE).size / 1048576).toFixed(1)} Mo` : '';
  const apkSource = hasApk
    ? 'APK hébergé par ce serveur (<code>deploy/apk/</code>).'
    : `APK distribué par les Releases GitHub — build : <a href="${ACTIONS_URL}">workflow « Build APK Android »</a>.`;
  const host = (req.headers.host || '').split(':')[0];

  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Installer Scoot Master</title>
<link rel="icon" href="/favicon.ico">
<style>
 :root{--brand:#FF5A1F}
 *{box-sizing:border-box}
 body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#F6F7F9;color:#17191C;line-height:1.55}
 .wrap{max-width:720px;margin:0 auto;padding:28px 18px 48px}
 .hero{display:flex;gap:14px;align-items:center;margin-bottom:8px}
 .logo{width:60px;height:60px;border-radius:14px}
 h1{font-size:24px;margin:0} .sub{color:#6B7280;margin:2px 0 0;font-size:14px}
 a.cta{display:block;text-align:center;background:var(--brand);color:#fff;text-decoration:none;
       font-weight:700;font-size:17px;padding:15px;border-radius:12px;margin:20px 0 6px}
 a.cta:active{opacity:.85}
 .note{font-size:12.5px;color:#6B7280;text-align:center;margin:0 0 22px}
 .card{background:#fff;border:1px solid #E5E7EB;border-radius:14px;padding:16px;margin-bottom:12px}
 .card h2{font-size:15px;margin:0 0 6px} .card p{margin:0;font-size:13.5px;color:#4B5563}
 ol,ul{margin:6px 0 0;padding-left:20px;font-size:13.5px;color:#4B5563}
 code{background:#F3F4F6;padding:1px 6px;border-radius:6px;font-size:12.5px}
 .tag{display:inline-block;background:#FFF0EA;color:var(--brand);border-radius:999px;
      padding:2px 10px;font-size:12px;font-weight:700;margin-bottom:6px}
 a{color:var(--brand)}
</style></head><body><div class="wrap">
 <div class="hero">
   <img class="logo" src="/icons/icon-192.png" alt="Scoot Master">
   <div><h1>Installer Scoot Master</h1><p class="sub">Catalogue motos 4T, ventes &amp; clients — hors ligne inclus.</p></div>
 </div>

 <a class="cta" href="${apkHref}">📱 Télécharger l'APK Android${sizeMb}</a>
 <p class="note">${apkSource}</p>

 <div class="card"><span class="tag">Android</span>
  <h2>Application native (APK)</h2>
  <p>Téléchargez l'APK, ouvrez-le et autorisez « Sources inconnues » si le navigateur le demande.
     L'application s'installe avec ses propres icône et base de données locale.</p>
  <ol><li>Touchez le bouton ci-dessus ;</li><li>Ouvrez le fichier téléchargé ;</li><li>« Installer ».</li></ol>
 </div>

 <div class="card"><span class="tag">Android · sans APK</span>
  <h2>Installer depuis le navigateur (PWA)</h2>
  <p>Chrome / Edge / Samsung Internet : menu <b>⋮</b> puis <b>« Installer l'application »</b> —
     l'icône rejoint l'écran d'accueil et l'app s'ouvre en plein écran.</p>
 </div>

 <div class="card"><span class="tag">Ordinateur</span>
  <h2>Application de bureau</h2>
  <p>Ouvrez <a href="https://${host || 'localhost:8080'}/">l'application</a> puis, dans Chrome ou Edge :
     menu <b>⋮</b> → <b>« Installer Scoot Master… »</b> (ou l'icône d'installation dans la barre d'adresse).
     Scoot Master s'ouvre alors dans sa propre fenêtre, comme un logiciel classique.</p>
 </div>

 <div class="card"><span class="tag">iPhone / iPad</span>
  <h2>Sur l'écran d'accueil</h2>
  <p>Safari : bouton <b>Partager</b> puis <b>« Sur l'écran d'accueil »</b>.
     (Chrome sur iOS ne propose pas l'installation.)</p>
 </div>

 <div class="card">
  <h2>Après l'installation</h2>
  <p>Comptes de démonstration : <code>admin / admin123</code> (administrateur) et
     <code>vendeur / vendeur123</code>. Toutes les saisies fonctionnent hors ligne et sont
     synchronisées au retour du réseau (onglet <b>Sync</b> : exports, sauvegarde, conflits).</p>
 </div>
</div></body></html>`;

  securityHeaders(res);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
}

/** Sert l'APK hébergé dans `deploy/apk/`, sinon redirige vers la Release GitHub. */
function sendApk(req, res, urlPath) {
  const requested = path.basename(urlPath);
  const file = path.join(APK_DIR, requested);
  if (fs.existsSync(file) && fs.statSync(file).isFile() && file.startsWith(APK_DIR)) {
    securityHeaders(res);
    res.writeHead(200, {
      'Content-Type': MIME['.apk'],
      'Content-Length': fs.statSync(file).size,
      'Content-Disposition': `attachment; filename="${requested}"`,
    });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(302, { Location: APK_REMOTE_URL });
  res.end();
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  // 1) API → backend
  if (urlPath === '/api' || urlPath.startsWith('/api/')) return proxyApi(req, res);

  // 2) Raccourcis d'installation : page guide + APK
  if (urlPath === '/install' || urlPath === '/install/') return sendInstallPage(req, res);
  if (urlPath.startsWith('/apk/')) return sendApk(req, res, urlPath);

  // 3) Fichiers statiques
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(WEB_ROOT, safePath);
  if (filePath.startsWith(WEB_ROOT) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return sendFile(res, filePath);
  }

  // 4) Repli SPA
  const index = path.join(WEB_ROOT, 'index.html');
  if (fs.existsSync(index)) return sendFile(res, index);

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Build web introuvable — lancez « npx expo export --platform web » dans mobile/.');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🏍️  Scoot Master Web — http://0.0.0.0:${PORT}`);
  console.log(`   statique : ${WEB_ROOT}`);
  console.log(`   /api/*  → ${API_TARGET}`);
  console.log(`   /install → page « Installer Scoot Master » (APK : ${fs.existsSync(APK_FILE) ? 'hébergé ici' : 'Release GitHub'})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
