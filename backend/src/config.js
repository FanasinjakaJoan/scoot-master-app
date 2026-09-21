'use strict';

const path = require('path');

function loadEnv() {
  // Mini-lecteur .env (pas de dépendance) : backend/.env si présent.
  try {
    const fs = require('fs');
    const file = path.join(__dirname, '..', '.env');
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
      }
    }
  } catch { /* .env optionnel */ }
}

loadEnv();

/**
 * Convertit une durée type `30d`, `12h`, `45m`, `90s` (ou un nombre de
 * secondes) en secondes. Renvoie `fallback` si la valeur est inexploitable.
 */
function ttlToSeconds(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*([smhdwy])$/i);
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const factor = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 }[unit];
  return Math.round(n * factor);
}

// Durée de vie du jeton de session.
// Nouvelle stratégie « session permanente » : jeton de très longue durée
// (1 an par défaut, surchargeable via JWT_TTL) + renouvellement silencieux
// en arrière-plan. La session ne prend fin QUE sur déconnexion explicite
// côté client — jamais automatiquement sur 401/403.
const JWT_TTL = process.env.JWT_TTL || '1y';

// Fenêtre de tolérance pendant laquelle un jeton déjà expiré reste acceptable
// pour un *renouvellement* (et uniquement pour cela : /api/auth/refresh).
// Avec des jetons d'1 an, on garde une grâce large (2 ans) pour les appareils
// restés très longtemps hors ligne.
const JWT_REFRESH_GRACE = process.env.JWT_REFRESH_GRACE || '2y';

/**
 * Normalise `CORS_ORIGIN` en liste d'origines.
 *
 * Tolère les saisies réelles d'un tableau de bord : espaces autour des entrées,
 * URL terminées par `/`, ou origine réduite à un hôte. Une valeur vide, `*` ou
 * la valeur littérale `false` active le mode ouvert (toutes les origines).
 *
 * Une entrée inexploitable est ignorée au lieu de faire échouer le démarrage :
 * une faute de frappe dans cette variable ne doit jamais empêcher l'API de
 * répondre (c'était le cas de figure qui coupait la synchronisation avec une
 * liste blanche trop restrictive).
 */
function parseCorsOrigins(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw || raw === '*' || raw.toLowerCase() === 'false') return '*';
  return raw
    .split(',')
    .map((entry) => normalizeOrigin(entry))
    .filter(Boolean);
}

/** Ramène une entrée de configuration à son origine (`scheme://host[:port]`). */
function normalizeOrigin(entry) {
  const trimmed = String(entry).trim();
  if (!trimmed || trimmed === '*') return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return null;
  }
}

const corsOrigins = parseCorsOrigins(process.env.CORS_ORIGIN);

const config = {
  port: Number(process.env.PORT || 4000),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'scoot.db'),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-scoot-master',
  jwtTtl: JWT_TTL,
  jwtTtlSeconds: ttlToSeconds(JWT_TTL, 365 * 86400),
  jwtRefreshGraceSeconds: ttlToSeconds(JWT_REFRESH_GRACE, 2 * 365 * 86400),
  /** Origines autorisées : `'*'` ou tableau normalisé. */
  corsOrigins,
  /**
   * Mode strict : refuse réellement les origines hors liste. Désactivé par
   * défaut — l'API s'authentifie par en-tête `Authorization` (aucun cookie),
   * donc refléter l'origine ne crée pas de risque CSRF, alors qu'un refus
   * silencieux casse toute la synchronisation de l'app web.
   */
  corsStrict: String(process.env.CORS_STRICT).toLowerCase() === 'true',
  seedOnStart: String(process.env.SEED_ON_START).toLowerCase() !== 'false',
};

module.exports = { config, ttlToSeconds, parseCorsOrigins };
