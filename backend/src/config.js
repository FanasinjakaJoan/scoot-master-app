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
// La session doit rester ouverte tant que l'utilisateur ne se déconnecte pas
// lui-même : on retient une durée longue (30 jours par défaut), complétée par
// le renouvellement glissant (POST /api/auth/refresh) déclenché par l'app.
const JWT_TTL = process.env.JWT_TTL || '30d';

// Fenêtre de tolérance pendant laquelle un jeton déjà expiré reste acceptable
// pour un *renouvellement* (et uniquement pour cela : /api/auth/refresh).
// Elle évite la déconnexion brutale d'un appareil resté hors ligne ou en
// veille plus longtemps que la durée de vie du jeton. Défaut : 60 jours.
const JWT_REFRESH_GRACE = process.env.JWT_REFRESH_GRACE || '60d';

const config = {
  port: Number(process.env.PORT || 4000),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'scoot.db'),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-scoot-master',
  jwtTtl: JWT_TTL,
  jwtTtlSeconds: ttlToSeconds(JWT_TTL, 30 * 86400),
  jwtRefreshGraceSeconds: ttlToSeconds(JWT_REFRESH_GRACE, 60 * 86400),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  seedOnStart: String(process.env.SEED_ON_START).toLowerCase() !== 'false',
};

module.exports = { config, ttlToSeconds };
