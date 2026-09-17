'use strict';

/**
 * Adaptateur SQLite : expose l'API minimaliste de better-sqlite3
 * (prepare/get/all/run/exec/pragma/transaction/close) en s'appuyant sur
 * le module Node intégré `node:sqlite` (Node ≥ 22) — aucune dépendance native.
 */

const { DatabaseSync } = require('node:sqlite');

class Statement {
  constructor(stmt) { this._s = stmt; }
  run(...params) { return this._s.run(...params); }
  get(...params) { return this._s.get(...params); }
  all(...params) { return this._s.all(...params); }
}

class Db {
  constructor(path) {
    this._db = new DatabaseSync(path);
  }
  exec(sql) { return this._db.exec(sql); }
  pragma(source) { try { return this._db.pragma(source); } catch (e) {
    if (!/foreign_keys|journal_mode/i.test(source)) throw e;
    // certains pragmas de configuration acceptent la syntaxe SQL directe
    try { this._db.exec(`PRAGMA ${source}`); } catch { /* sans effet */ }
    return undefined;
  } }
  prepare(sql) { return new Statement(this._db.prepare(sql)); }
  /** Exécute `fn` dans une transaction (COMMIT/ROLLBACK automatique). */
  transaction(fn) {
    return (...args) => {
      this._db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn(...args);
        this._db.exec('COMMIT');
        return result;
      } catch (e) {
        try { this._db.exec('ROLLBACK'); } catch { /* déjà annulé */ }
        throw e;
      }
    };
  }
  close() { this._db.close(); }
}

module.exports = { Db };
