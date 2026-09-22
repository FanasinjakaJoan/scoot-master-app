'use strict';

const fs = require('fs');
const path = require('path');
const { Db } = require('./connection');
const { SCHEMA } = require('./schema');
const { seedIfEmpty } = require('./seed');

/**
 * Migrations idempotentes pour les bases créées avant l'introduction de
 * l'isolation des données (`owner_id`). SQLite ne sait pas ajouter une colonne
 * à une table existante via `CREATE TABLE IF NOT EXISTS` : on inspecte donc
 * `PRAGMA table_info` et on ajoute la colonne manquante.
 */
function migrateOwnership(db) {
  for (const table of ['bikes', 'customers', 'sales']) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes('owner_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN owner_id TEXT`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_owner ON ${table} (owner_id)`);
    }
  }
  // Rétro-remplissage : les lignes historiques (créées avant l'isolation) sont
  // attribuées au premier administrateur, afin qu'elles restent visibles et
  // gérables au lieu de devenir orphelines (invisibles pour tous les vendeurs
  // et sans propriétaire pour l'admin).
  backfillOwnership(db);
}

/** Attribue les lignes sans propriétaire à un administrateur (s'il en existe un). */
function backfillOwnership(db) {
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL ORDER BY created_at LIMIT 1").get();
  if (!admin) return;
  for (const table of ['bikes', 'customers', 'sales']) {
    db.prepare(`UPDATE ${table} SET owner_id = ? WHERE owner_id IS NULL`).run(admin.id);
  }
}

/**
 * Ouvre (et initialise si nécessaire) la base SQLite du serveur.
 * @param {string} dbPath chemin du fichier .db (':memory:' pour les tests)
 */
function openDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new Db(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrateOwnership(db);
  return db;
}

/**
 * Crée la base, applique le schéma et sème les données de démo si demandées.
 */
function initDb({ dbPath, seedOnStart = false, seedUsersOnly = false } = {}) {
  const db = openDb(dbPath || './data/scoot.db');
  if (seedOnStart) seedIfEmpty(db, { usersOnly: seedUsersOnly });
  return db;
}

module.exports = { openDb, initDb };
