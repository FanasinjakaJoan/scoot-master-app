'use strict';

const fs = require('fs');
const path = require('path');
const { Db } = require('./connection');
const { SCHEMA } = require('./schema');
const { seedIfEmpty } = require('./seed');

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
