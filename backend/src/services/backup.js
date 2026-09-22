'use strict';

/**
 * Sauvegarde automatisée des données (dump complet) vers Google Drive.
 *
 * Le dump est un JSON contenant TOUTES les entités (motos, clients, ventes +
 * lignes, utilisateurs sans empreinte de mot de passe) — c'est une sauvegarde
 * d'infrastructure, réservée aux administrateurs, et elle ignore donc
 * volontairement l'isolation applicative par `owner_id`.
 *
 * Le fichier produit est un export logique (portable entre environnements)
 * plutôt qu'une copie brute du fichier SQLite : il reste exploitable pour
 * restaurer ou migrer vers PostgreSQL.
 *
 * Une sauvegarde peut être déclenchée :
 *  - par la tâche planifiée interne (`startBackupScheduler`) ;
 *  - manuellement via `POST /api/exports/backup/drive` (admin) ;
 *  - par un CRON externe (Render Cron Job, GitHub Actions…) qui appelle cette route.
 */

const { config } = require('../config');
const { GoogleDriveClient, GoogleDriveError } = require('./google-drive');
const { nowIso } = require('../util/ids');

/** Horodatage compact utilisable dans un nom de fichier. */
function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** Construit le dump logique complet de la base. */
function buildBackup(db, { format = 'json', exportedBy = null } = {}) {
  const bikes = db.prepare('SELECT * FROM bikes').all().map((b) => ({ ...b, photos: safeJson(b.photos) }));
  const customers = db.prepare('SELECT * FROM customers').all();
  const sales = db.prepare('SELECT * FROM sales').all().map((s) => ({
    ...s,
    items: db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(s.id),
  }));
  // Les comptes sont inclus SANS le hash de mot de passe (moindre privilège :
  // une sauvegarde ne doit pas devenir un lot d'identifiants réutilisables).
  const users = db.prepare('SELECT id, username, full_name, role, created_at, updated_at, deleted_at FROM users').all();
  return {
    app: 'scoot-master',
    version: 1,
    exportedAt: nowIso(),
    exportedBy,
    counts: { bikes: bikes.length, customers: customers.length, sales: sales.length, users: users.length },
    bikes,
    customers,
    sales,
    users,
  };
}

/** Sérialise le dump selon le format demandé (`json` par défaut). */
function serializeBackup(db, { format = 'json', exportedBy = null } = {}) {
  const dump = buildBackup(db, { format, exportedBy });
  const date = new Date();
  if (format === 'csv') {
    return {
      name: `scoot-backup-${stamp(date)}.csv`,
      mimeType: 'text/csv; charset=utf-8',
      content: toCsv(dump),
      dump,
    };
  }
  return {
    name: `scoot-backup-${stamp(date)}.json`,
    mimeType: 'application/json',
    content: JSON.stringify(dump, null, 2),
    dump,
  };
}

/** Export CSV « une section par entité » (lisible dans un tableur). */
function toCsv(dump) {
  const sections = [];
  const section = (title, rows) => {
    if (!rows.length) { sections.push(`# ${title}\n(aucune ligne)`); return; }
    const cols = Object.keys(rows[0]);
    const escape = (v) => {
      const s = v === null || v === undefined ? '' : Array.isArray(v) || typeof v === 'object' ? JSON.stringify(v) : String(v);
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    sections.push([
      `# ${title}`,
      cols.join(';'),
      ...rows.map((r) => cols.map((c) => escape(r[c])).join(';')),
    ].join('\n'));
  };
  section('motos', dump.bikes);
  section('clients', dump.customers);
  section('ventes', dump.sales.map((s) => ({ ...s, items: undefined })));
  section('utilisateurs', dump.users);
  return sections.join('\n\n');
}

/**
 * Crée une sauvegarde et la téléverse vers Google Drive.
 *
 * @param {object} db base SQLite
 * @param {object} [opts]
 * @param {GoogleDriveClient} [opts.client] client Drive (injectable en test)
 * @param {string} [opts.format] `json` (défaut) ou `csv`
 * @param {string} [opts.exportedBy] identifiant de l'auteur du déclenchement
 * @returns {Promise<object>} descripteur de la sauvegarde envoyée
 */
async function backupToDrive(db, opts = {}) {
  const client = opts.client || new GoogleDriveClient();
  if (!client.configured) {
    throw new GoogleDriveError('Compte de service Google non configuré (GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY).', 0);
  }
  const format = opts.format || config.backup.format;
  const { name, mimeType, content, dump } = serializeBackup(db, { format, exportedBy: opts.exportedBy || null });

  const uploaded = await client.uploadFile({
    name,
    content,
    mimeType,
    folderId: opts.folderId,
  });

  return {
    ok: true,
    file: uploaded,
    name,
    size: Buffer.byteLength(content),
    format,
    counts: dump.counts,
    uploadedAt: nowIso(),
  };
}

/**
 * Tâche planifiée interne (remplace un vrai CRON : pas de dépendance externe).
 * Déclenche une sauvegarde toutes les `config.backup.intervalHours` heures.
 *
 * Active uniquement si `BACKUP_ENABLED=true` ET qu'un compte de service est
 * configuré — sinon no-op (l'API ne doit jamais planter pour une sauvegarde).
 *
 * @returns {{ stop: () => void, runNow: () => Promise<object> }}
 */
function startBackupScheduler(db, { client, logger = console, intervalHours } = {}) {
  const every = Number(intervalHours || config.backup.intervalHours || 24);
  let timer = null;
  let stopped = false;

  async function runNow(reason = 'scheduled') {
    if (stopped) return { ok: false, skipped: 'stopped' };
    try {
      const result = await backupToDrive(db, { client });
      logger.log(`[backup] sauvegarde Google Drive (${reason}) OK → ${result.name} (${result.size} octets)`);
      return result;
    } catch (e) {
      logger.error(`[backup] échec de la sauvegarde Google Drive (${reason}) :`, e.message);
      return { ok: false, error: e.message };
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => {
      await runNow();
      schedule();
    }, Math.max(1, every) * 3600 * 1000);
    if (timer.unref) timer.unref();
  }

  const shouldStart = config.backup.enabled && (client ? client.configured : config.backup.googleConfigured);
  if (shouldStart) {
    logger.log(`[backup] planificateur actif — sauvegarde Google Drive toutes les ${every} h.`);
    schedule();
  } else if (config.backup.enabled) {
    logger.warn('[backup] BACKUP_ENABLED=true mais compte de service Google incomplet — sauvegarde désactivée.');
  }

  return {
    runNow,
    stop: () => { stopped = true; if (timer) clearTimeout(timer); timer = null; },
  };
}

function safeJson(v) {
  try { return JSON.parse(v); } catch { return []; }
}

module.exports = { backupToDrive, buildBackup, serializeBackup, startBackupScheduler, stamp };
