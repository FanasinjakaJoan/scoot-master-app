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

const config = {
  port: Number(process.env.PORT || 4000),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'scoot.db'),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-scoot-master',
  jwtTtl: process.env.JWT_TTL || '12h',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  seedOnStart: String(process.env.SEED_ON_START).toLowerCase() !== 'false',
};

module.exports = { config };
