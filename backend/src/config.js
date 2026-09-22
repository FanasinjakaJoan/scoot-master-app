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

/**
 * Normalise une clé privée de compte de service Google.
 * Les tableaux de bord et `.env` transmettent souvent la clé sur une seule
 * ligne avec des `\n` littéraux (les vraies retours à la ligne cassent le
 * parsing des fichiers d'environnement) : on les restaure ici.
 */
function parsePrivateKey(value) {
  if (!value) return '';
  return String(value).replace(/\\n/g, '\n').trim();
}

/** Durée (en heures) entre deux sauvegardes automatiques Google Drive. */
function parseBackupIntervalHours(value, fallback = 24) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

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

  /**
   * Sauvegarde automatisée vers Google Drive (compte de service).
   * `enabled` n'est vrai que si un compte de service complet est configuré
   * (e-mail client + clé privée) : sans ces deux valeurs, la fonctionnalité
   * reste silencieusement inerte et l'API démarre normalement.
   */
  backup: {
    googleClientEmail: process.env.GOOGLE_CLIENT_EMAIL || '',
    googlePrivateKey: parsePrivateKey(process.env.GOOGLE_PRIVATE_KEY),
    /** Dossier Drive cible (partagé avec le compte de service). Vide = racine. */
    googleDriveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
    googleDriveFolderName: process.env.GOOGLE_DRIVE_FOLDER_NAME || 'Scoot Master Backups',
    /** Format d'export : `json` (dump applicatif) ; `csv` généré en plus si demandé. */
    format: (process.env.BACKUP_FORMAT || 'json').toLowerCase() === 'csv' ? 'csv' : 'json',
    /** Planification CRON interne (intervalle en heures). 0 désactive. */
    intervalHours: parseBackupIntervalHours(process.env.BACKUP_INTERVAL_HOURS, 24),
    enabled: String(process.env.BACKUP_ENABLED).toLowerCase() === 'true',
    /** Serveur de jetons OAuth2 du compte de service. */
    tokenUri: process.env.GOOGLE_TOKEN_URI || 'https://oauth2.googleapis.com/token',
    driveApiBase: process.env.GOOGLE_DRIVE_API_BASE || 'https://www.googleapis.com/drive/v3',
    uploadApiBase: process.env.GOOGLE_UPLOAD_API_BASE || 'https://www.googleapis.com/upload/drive/v3',
  },
};

/** Vrai si un compte de service Google complet est configuré. */
config.backup.googleConfigured = Boolean(
  config.backup.googleClientEmail && config.backup.googlePrivateKey
);

module.exports = { config, ttlToSeconds, parseCorsOrigins, parsePrivateKey };
