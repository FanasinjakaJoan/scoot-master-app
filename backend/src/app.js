'use strict';

const express = require('express');
const { config } = require('./config');
const { corsMiddleware } = require('./middleware/cors');
const { errorHandler } = require('./middleware/error');

const authRoutes = require('./routes/auth');
const bikeRoutes = require('./routes/bikes');
const customerRoutes = require('./routes/customers');
const saleRoutes = require('./routes/sales');
const syncRoutes = require('./routes/sync');
const exportRoutes = require('./routes/exports');
const userRoutes = require('./routes/users');

/**
 * Fabrique l'application Express (séparable du serveur pour les tests).
 * @param {import('better-sqlite3').Database} db
 * @param {{ corsOrigins?: string[]|'*', corsStrict?: boolean }} [options]
 *   surcharge CORS pour les tests ; par défaut la configuration d'environnement.
 */
function createApp(db, options = {}) {
  const corsOrigins = options.corsOrigins ?? config.corsOrigins;
  const corsStrict = options.corsStrict ?? config.corsStrict;
  const app = express();
  app.disable('x-powered-by');
  // Base portée par l'application : le middleware d'authentification y relit le
  // compte à chaque requête (révocation effective, rôle lu en base et non dans
  // le jeton) sans que chaque route ait à lui transmettre `db`.
  app.locals.db = db;
  // CORS AVANT les routes : l'app web déployée appelle l'API en cross-origin
  // (l'edge de l'hébergeur redirige /api/* vers le domaine de l'API). Sans
  // `Access-Control-Allow-Origin`, le navigateur bloque la réponse et la
  // synchronisation échoue en « 403 ». Voir middleware/cors.js.
  app.use(
    corsMiddleware(corsOrigins, {
      strict: corsStrict,
      warn: (message) => console.warn('[cors]', message),
    })
  );
  app.use(express.json({ limit: '5mb' }));

  // --- Statut / diagnostic (sans auth, pour les moniteurs) ---
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'scoot-master-api', time: new Date().toISOString() });
  });

  // --- Page d'accueil (aperçu navigateur / découverte de l'API) ---
  app.get('/', (req, res) => {
    const eps = [
      ['GET', '/api/health', 'État du service'],
      ['POST', '/api/auth/login', 'Connexion → JWT  {username, password}'],
      ['POST', '/api/auth/check', 'Validation session SANS 401 (toujours 200) — évite le log navigateur au chargement'],
      ['POST', '/api/auth/refresh-safe', 'Renouvellement SANS 401 (toujours 200) — keep-alive / maintien pendant sync'],
      ['GET', '/api/auth/me', 'Profil utilisateur (auth)'],
      ['GET', '/api/bikes', 'Catalogue (filtres: status, brand, q, minPrice, maxPrice, sort, order) (auth)'],
      ['GET', '/api/bikes/meta', 'Marques & statuts (auth)'],
      ['GET', '/api/bikes/:id', 'Fiche moto (auth)'],
      ['POST', '/api/bikes', 'Créer une moto (auth)'],
      ['PUT', '/api/bikes/:id', 'Modifier une moto (auth)'],
      ['DELETE', '/api/bikes/:id', 'Supprimer une moto (admin)'],
      ['GET', '/api/customers', 'Clients + stats achats (auth)'],
      ['GET', '/api/customers/:id/purchases', 'Historique d\u2019achats d\u2019un client (auth)'],
      ['POST', '/api/customers', 'Créer un client (auth)'],
      ['PUT', '/api/customers/:id', 'Modifier un client (auth)'],
      ['GET', '/api/sales', 'Ventes / bons de commande (auth)'],
      ['POST', '/api/sales', 'Créer une vente {customer_id, items[], ...} (auth)'],
      ['PUT', '/api/sales/:id', 'Modifier une vente (statut, paiement, lignes) (auth)'],
      ['DELETE', '/api/sales/:id', 'Supprimer une vente (admin)'],
      ['POST', '/api/sync/push', 'Synchronisation : pousser les opérations hors ligne (auth)'],
      ['GET', '/api/sync/pull?since=ISO', 'Synchronisation : tirer les changements serveur (auth)'],
      ['GET', '/api/sync/status', 'Compteurs globaux (auth)'],
      ['GET', '/api/exports/bikes|customers|sales?format=json|csv', 'Export JSON / CSV (périmètre utilisateur)'],
      ['GET', '/api/exports/backup', 'Sauvegarde complète JSON (périmètre utilisateur)'],
      ['POST', '/api/exports/backup', 'Téléverser une sauvegarde locale (auth)'],
      ['GET', '/api/exports/backups', 'Liste des sauvegardes téléversées (admin)'],
      ['POST', '/api/exports/backup/drive', 'Sauvegarde complète → Google Drive (admin)'],
      ['GET', '/api/exports/backup/drive', 'Sauvegardes présentes sur Google Drive (admin)'],
      ['GET', '/api/exports/audit', 'Journal d\u2019audit des actions sensibles (admin)'],
    ];
    const rows = eps.map(([m, p, d]) => `<tr><td class="m">${m}</td><td class="p">${p}</td><td>${d}</td></tr>`).join('\n');
    res.type('html').send(`<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scoot Master — API de synchronisation</title>
<style>
 body{font-family:system-ui,sans-serif;margin:0;background:#111;color:#eee}
 .wrap{max-width:860px;margin:0 auto;padding:32px 20px}
 h1{font-size:24px} h1 span{color:#ff5a1f}
 .badge{display:inline-block;background:#1c1c1c;border:1px solid #333;border-radius:999px;padding:4px 12px;margin:4px 6px 4px 0;font-size:13px}
 table{width:100%;border-collapse:collapse;margin-top:24px;font-size:14px}
 td{padding:8px 10px;border-bottom:1px solid #222;vertical-align:top}
 td.m{width:64px;font-weight:600;color:#7ec8ff;white-space:nowrap}
 td.p{font-family:ui-monospace,monospace;color:#ffd166;white-space:nowrap}
 .foot{margin-top:28px;color:#777;font-size:13px}
 code{background:#1c1c1c;padding:2px 6px;border-radius:6px}
</style></head><body><div class="wrap">
<h1>🏍️ <span>Scoot Master</span> — API de synchronisation</h1>
<p>Backend offline-first : catalogue, ventes &amp; clients, file de synchronisation (push/pull),
résolution de conflits <em>Last-Write-Wins</em> avec validation admin, exports JSON/CSV.</p>
<div>
 <span class="badge">POST /api/auth/login — authentification sécurisée</span>
</div>
<table>${rows}</table>
<p class="foot">Accès administrateur requis pour la gestion des utilisateurs.
Documentation : <code>docs/API.md</code>, schéma : <code>docs/DATABASE_SCHEMA.md</code>, logique de sync : <code>docs/SYNC.md</code>.</p>
</div></body></html>`);
  });

  app.use('/api/auth', authRoutes(db));
  app.use('/api/users', userRoutes(db));
  app.use('/api/bikes', bikeRoutes(db));
  app.use('/api/customers', customerRoutes(db));
  app.use('/api/sales', saleRoutes(db));
  app.use('/api/sync', syncRoutes(db));
  app.use('/api/exports', exportRoutes(db));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Route introuvable.' }));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
