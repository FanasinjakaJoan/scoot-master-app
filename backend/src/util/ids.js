'use strict';

const crypto = require('crypto');

/** UUID v4 — même format côté client (l'app mobile génère ses propres UUID hors ligne). */
const uuid = () => crypto.randomUUID();

/** Horodatage ISO-8601 UTC courant. */
const nowIso = () => new Date().toISOString();

/**
 * Affecte un numéro de bon de commande unique `BC-AAAA-NNNN`
 * à partir du compteur annuel. Si `proposed` est fourni et disponible, il est conservé.
 */
function allocateSaleNumber(db, proposed, year) {
  const y = year || new Date().getFullYear();
  const exists = (num) =>
    db.prepare('SELECT 1 FROM sales WHERE sale_number = ?').get(num);

  if (proposed) {
    const row = db
      .prepare('SELECT id, deleted_at FROM sales WHERE sale_number = ?')
      .get(proposed);
    if (!row || row.deleted_at) return proposed;
  }

  let seq = db.prepare('SELECT last FROM sale_counters WHERE year = ?').get(y)?.last || 0;
  let guard = 0;
  let num;
  do {
    seq += 1;
    num = `BC-${y}-${String(seq).padStart(4, '0')}`;
    guard += 1;
  } while (exists(num) && guard < 100000);

  db.prepare(
    'INSERT INTO sale_counters (year, last) VALUES (?, ?) ON CONFLICT(year) DO UPDATE SET last = excluded.last'
  ).run(y, seq);
  return num;
}

module.exports = { uuid, nowIso, allocateSaleNumber };
