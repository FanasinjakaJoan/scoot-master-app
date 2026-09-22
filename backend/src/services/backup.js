'use strict';

const { config } = require('../config');
const { createFirebaseService } = require('./firebase');
const { nowIso, uuid } = require('../util/ids');

/**
 * Sauvegarde des données vers Firebase.
 *
 * Deux origines possibles pour la sauvegarde :
 *  - le contenu applicatif (base SQLite locale, sérialisé en JSON) — mode par
 *    défaut ; c'est ce que produit aussi `GET /api/exports/backup` ;
 *  - l'export **natif Firestore → GCS** lorsque les données vivent dans
 *    Firestore (`FIREBASE_FIRESTORE_EXPORT_ENABLED=true`).
 *
 * Le service est volontairement injectable (bucket, transport, horloge, veille)
 * afin que les tests exercent les chemins réels — réessais, rotation,
 * restauration — sans réseau ni compte de service.
 */

const BACKUP_VERSION = 1;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 200;
/** Au-delà de cette durée, un verrou de sauvegarde est considéré comme abandonné. */
const STALE_LOCK_MS = 30 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * Sérialise l'intégralité de la base applicative — y compris les tombstones,
 * sans quoi une restauration ressusciterait des enregistrements supprimés.
 */
function buildSnapshot(db, { reason = 'manual', actor = null, exportedAt = nowIso() } = {}) {
  const rows = (entity, includeDeleted = false) =>
    db.prepare(`SELECT * FROM ${entity} ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'}`).all();
  const bikes = rows('bikes', true);
  const customers = rows('customers', true);
  const sales = db.prepare('SELECT * FROM sales').all().map((s) => ({
    ...s,
    items: db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(s.id),
  }));
  return {
    app: 'scoot-master',
    version: BACKUP_VERSION,
    kind: 'full',
    reason,
    actor: actor ? { id: actor.id, username: actor.username, role: actor.role } : null,
    exportedAt,
    counts: {
      bikes: bikes.length,
      customers: customers.length,
      sales: sales.length,
      sale_items: sales.reduce((n, s) => n + s.items.length, 0),
    },
    bikes,
    customers,
    sales,
  };
}

/** Liste des colonnes d'une table (via la fonction table-valued `pragma_table_info`). */
function tableColumns(db, table) {
  return db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((r) => r.name);
}

/** Restaure une ligne par upsert, en ne retenant que les colonnes existantes. */
function upsertRow(db, table, row) {
  const columns = tableColumns(db, table).filter((c) => Object.prototype.hasOwnProperty.call(row, c));
  if (!columns.length) return false;
  const placeholders = columns.map(() => '?').join(', ');
  const updates = columns.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ');
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})
    ON CONFLICT(id) DO UPDATE SET ${updates || 'id = id'}`;
  db.prepare(sql).run(...columns.map((c) => row[c]));
  return true;
}

/**
 * Restaure une sauvegarde dans la base (fusion par identifiant).
 *
 * La fusion — et non un remplacement total — est le choix sûr : une
 * restauration ne doit jamais effacer des enregistrements créés depuis la
 * sauvegarde. Les tombstones du fichier sont appliqués, donc un enregistrement
 * supprimé au moment de la sauvegarde le reste après restauration.
 *
 * Chaque ligne restaurée voit son `updated_at` porté à l'instant de la
 * restauration (et son `version` incrémenté). C'est indispensable à la
 * propagation : le pull ne renvoie que `updated_at > curseur du client`, et un
 * client déjà synchronisé ignore un upsert dont l'horodatage est plus ancien que
 * sa copie locale. Sans cette remise à l'heure, restaurer un fichier ne
 * changerait rien chez les téléphones. Les tombstones voient leur `deleted_at`
 * remis à l'heure pour la même raison — sinon la ligne serait renvoyée comme un
 * upsert actif et l'enregistrement supprimé ressusciterait côté client.
 *
 * Une ligne que la base refuse (collision de clé unique sur `sale_number` avec
 * un identifiant différent, contrainte…) est **ignorée et signalée** plutôt que
 * d'interrompre la restauration : un fichier de sauvegarde ne doit jamais
 * laisser la base à moitié restaurée pour une seule ligne divergente.
 *
 * @returns {{bikes:number,customers:number,sales:number,sale_items:number,skipped:Array}}
 */
function restoreSnapshot(db, snapshot, { restoredAt = nowIso() } = {}) {
  if (!snapshot || snapshot.app !== 'scoot-master' || !Array.isArray(snapshot.bikes) || !Array.isArray(snapshot.customers) || !Array.isArray(snapshot.sales)) {
    throw new Error('Sauvegarde invalide (en-tête scoot-master et entités bikes/customers/sales attendus).');
  }
  const applied = { bikes: 0, customers: 0, sales: 0, sale_items: 0 };
  const skipped = [];

  const columnCache = new Map();
  const columnsOf = (table) => {
    if (!columnCache.has(table)) columnCache.set(table, tableColumns(db, table));
    return columnCache.get(table);
  };

  /** Aligne la ligne restaurée sur l'instant présent pour qu'elle se propage. */
  const freshen = (table, row) => {
    const columns = columnsOf(table);
    if (columns.includes('updated_at')) row.updated_at = restoredAt;
    if (columns.includes('version')) row.version = (Number(row.version) || 0) + 1;
    if (columns.includes('deleted_at') && row.deleted_at) row.deleted_at = restoredAt;
    return row;
  };

  const attempt = (table, row, counter) => {
    try {
      if (upsertRow(db, table, freshen(table, row))) applied[counter]++;
      return true;
    } catch (e) {
      skipped.push({ table, id: row && row.id, reason: e.message });
      return false;
    }
  };

  const run = db.transaction(() => {
    for (const bike of snapshot.bikes) attempt('bikes', bike, 'bikes');
    for (const customer of snapshot.customers) attempt('customers', customer, 'customers');
    for (const sale of snapshot.sales) {
      const { items, ...saleRow } = sale;
      const restored = attempt('sales', saleRow, 'sales');
      // Une vente refusée entraîne ses lignes : les restaurer violerait la clé
      // étrangère et ferait échouer toute la transaction.
      if (restored && Array.isArray(items)) {
        for (const item of items) attempt('sale_items', item, 'sale_items');
      }
    }
  });
  run();
  return { ...applied, skipped };
}

/**
 * Orchestre une sauvegarde : verrou anti-chevauchement, sérialisation,
 * téléversement avec réessais, métadonnées et rotation.
 */
function createBackupService({
  db,
  backup = config.firebaseBackup,
  serviceAccount = config.firebaseServiceAccount,
  firebase,
  logger = console,
  delay = sleep,
  now = nowIso,
  retries = MAX_RETRIES,
  buildSnapshotFn = buildSnapshot,
} = {}) {
  const service = firebase || createFirebaseService({ serviceAccount, backup });
  const history = [];
  let running = false;
  let runningSince = 0;
  let lastRun = null;

  /** Sérialise les exécutions ; reprend la main sur un verrou resté bloqué. */
  function acquireLock() {
    const since = Date.now();
    if (running && since - runningSince < STALE_LOCK_MS) return false;
    running = true;
    runningSince = since;
    return true;
  }

  function releaseLock() { running = false; }

  async function uploadWithRetry(path, buffer, metadata) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await service.uploadBuffer(path, buffer, { metadata });
        return { attempts: attempt + 1 };
      } catch (e) {
        lastError = e;
        logger.warn(`[backup] téléversement échoué (tentative ${attempt + 1}/${retries + 1}) : ${e.message}`);
        if (attempt < retries) await delay(BASE_RETRY_DELAY_MS * 2 ** attempt);
      }
    }
    throw lastError;
  }

  function record(entry) {
    history.unshift(entry);
    if (history.length > 100) history.length = 100;
    lastRun = entry;
    logger[entry.status === 'success' ? 'log' : 'error'](
      `[backup] ${entry.status} — ${entry.reason} — ${entry.size ?? 0} octets — ${entry.path || entry.error}`
    );
    return entry;
  }

  /**
   * Exécute une sauvegarde.
   * @param {{reason?: 'scheduled'|'manual', actor?: object, kind?: 'json'|'firestore', collectionIds?: string[]}} options
   * @returns {Promise<object>} métadonnées du run (jamais d'exception).
   */
  async function run({ reason = 'manual', actor = null, kind = backup.firestoreExport ? 'firestore' : 'json', collectionIds } = {}) {
    const startedAt = now();
    if (!backup.ready) {
      return record({
        id: uuid(), reason, actor: actor ? actor.username : null, startedAt, finishedAt: now(),
        durationMs: 0, size: null, status: 'skipped', path: null,
        error: backup.enabled
          ? 'Sauvegarde Firebase incomplète : renseignez FIREBASE_STORAGE_BUCKET et les identifiants du compte de service.'
          : 'Sauvegarde Firebase désactivée (FIREBASE_BACKUP_ENABLED=false).',
      });
    }
    if (!acquireLock()) {
      return record({
        id: uuid(), reason, actor: actor ? actor.username : null, startedAt, finishedAt: now(),
        durationMs: 0, size: null, status: 'skipped', path: null,
        error: 'Une sauvegarde est déjà en cours.',
      });
    }

    try {
      if (kind === 'firestore') {
        const operation = await service.exportFirestore(collectionIds);
        return record({
          id: uuid(), reason, actor: actor ? actor.username : null, startedAt, finishedAt: now(),
          durationMs: Date.now() - runningSince, size: null, status: 'success',
          path: `gs://${backup.bucket}/${backup.prefix}firestore`, kind,
          error: null, operation: operation && operation.name ? operation.name : null,
        });
      }

      const snapshot = buildSnapshotFn(db, { reason, actor, exportedAt: startedAt });
      const body = JSON.stringify(snapshot, null, 2);
      const buffer = Buffer.from(body, 'utf8');
      const fileName = `scoot-backup-${stamp()}.json`;
      const path = `${backup.prefix}${fileName}`;
      const metadata = {
        app: 'scoot-master',
        version: String(BACKUP_VERSION),
        reason,
        actor: actor ? actor.username : 'scheduled',
        exportedAt: snapshot.exportedAt,
        status: 'success',
        counts: JSON.stringify(snapshot.counts),
      };

      const { attempts } = await uploadWithRetry(path, buffer, metadata);
      const pruned = await service.pruneBackups(backup.retention).catch((e) => {
        logger.warn(`[backup] rotation ignorée : ${e.message}`);
        return [];
      });

      return record({
        id: uuid(), reason, actor: actor ? actor.username : null, startedAt, finishedAt: now(),
        durationMs: Date.now() - runningSince, size: buffer.length, status: 'success',
        path, kind: 'json', attempts, pruned, counts: snapshot.counts, error: null,
      });
    } catch (e) {
      return record({
        id: uuid(), reason, actor: actor ? actor.username : null, startedAt, finishedAt: now(),
        durationMs: Date.now() - runningSince, size: null, status: 'failure', path: null,
        kind, error: e.message || 'Échec de la sauvegarde.',
      });
    } finally {
      releaseLock();
    }
  }

  /** Liste les sauvegardes présentes dans le bucket (les plus récentes d'abord). */
  async function list() {
    return service.listFiles();
  }

  /**
   * Restaure une sauvegarde distante dans la base locale.
   * @param {string} path objet Storage à restaurer (ex. `backups/scoot-backup-….json`)
   */
  async function restore(path) {
    if (!path) throw new Error('Chemin de sauvegarde requis.');
    const buffer = await service.downloadBuffer(path);
    let snapshot;
    try { snapshot = JSON.parse(buffer.toString('utf8')); } catch { throw new Error('Fichier de sauvegarde illisible (JSON invalide).'); }
    const applied = restoreSnapshot(db, snapshot, { restoredAt: now() });
    logger.log(`[backup] restauration ${path} appliquée : ${JSON.stringify(applied)}`);
    return { path, exportedAt: snapshot.exportedAt || null, applied };
  }

  /** État courant exposé à l'API (dernier run + historique borné). */
  function state() {
    return {
      enabled: backup.enabled,
      ready: backup.ready,
      bucket: backup.bucket || null,
      prefix: backup.prefix,
      intervalHours: backup.intervalHours,
      retention: backup.retention,
      mode: backup.firestoreExport ? 'firestore' : 'json',
      running,
      lastRun,
      history: history.slice(0, 20),
    };
  }

  return { run, list, restore, state, buildSnapshot: (opts) => buildSnapshotFn(db, opts) };
}

/**
 * Planificateur de sauvegarde automatique.
 *
 * Applique une sauvegarde peu après le démarrage si la précédente remonte à
 * plus que l'intervalle, puis se répète. Les minuteurs sont `.unref()` : ils ne
 * maintiennent jamais le processus en vie (arrêt propre, tests).
 */
function createBackupScheduler({ service, intervalHours = config.firebaseBackup.intervalHours, logger = console, initialDelayMs = 60 * 1000 } = {}) {
  let timer = null;
  let stopped = false;

  async function tick(reason = 'scheduled') {
    if (stopped) return null;
    return service.run({ reason });
  }

  function start() {
    if (timer || !service) return;
    stopped = false;
    const intervalMs = Math.max(1, intervalHours) * 3600 * 1000;
    const last = service.state().lastRun;
    const elapsed = last && last.finishedAt ? Date.now() - Date.parse(last.finishedAt) : Infinity;
    const firstDelay = !last ? initialDelayMs : Math.max(0, intervalMs - elapsed);
    timer = setTimeout(async () => {
      await tick('scheduled');
      timer = setInterval(() => { tick('scheduled'); }, intervalMs);
      if (timer.unref) timer.unref();
    }, firstDelay);
    if (timer.unref) timer.unref();
    logger.log(`[backup] planificateur actif — toutes les ${intervalHours} h (première dans ${Math.round(firstDelay / 1000)} s)`);
  }

  function stop() {
    stopped = true;
    if (timer) { clearTimeout(timer); clearInterval(timer); timer = null; }
  }

  return { start, stop, tick };
}

module.exports = {
  createBackupService,
  createBackupScheduler,
  buildSnapshot,
  restoreSnapshot,
  upsertRow,
  tableColumns,
  BACKUP_VERSION,
  MAX_RETRIES,
  STALE_LOCK_MS,
};
