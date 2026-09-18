'use strict';

/**
 * Moteur de synchronisation offline-first (côté serveur).
 *
 * Protocole :
 *  - PUSH : l'app envoie un lot d'opérations (create/update/delete) portant l'UUID de
 *    l'entité et `clientTs` (horodatage local de la modification). Le serveur applique
 *    la règle **Last-Write-Wins** sur `updated_at` :
 *       • clientTs  > updated_at serveur → l'opération s'applique
 *       • clientTs  < updated_at serveur → CONFLIT (renvoyé au client, non appliqué)
 *       • clientTs  = updated_at         → tie-break déterministe par device_id
 *    Une opération avec `force: true` l'emporte uniquement si l'utilisateur est admin
 *    (validation administrative d'un conflit).
 *  - PULL : le serveur renvoie toutes les lignes modifiées (ou supprimées — tombstones)
 *    depuis un horodatage `since`, avec pagination par curseur clé.
 */

const crypto = require('crypto');
const { allocateSaleNumber } = require('../util/ids');

const ENTITY_FIELDS = {
  bikes: [
    'brand', 'model', 'year', 'mileage_km', 'engine_cc', 'color', 'serial_number',
    'price', 'currency', 'mechanical_state', 'aesthetic_state', 'status',
    'description', 'warehouse', 'photos',
  ],
  customers: ['first_name', 'last_name', 'phone', 'email', 'address', 'notes'],
  sales: [
    'customer_id', 'total', 'discount', 'amount_paid', 'payment_method',
    'payment_status', 'status', 'sale_date', 'notes',
  ],
};

const ENTITIES = Object.keys(ENTITY_FIELDS);

const parseJson = (v, fallback) => {
  try { return v === null || v === undefined ? fallback : JSON.parse(v); }
  catch { return fallback; }
};

function bikeRowToJson(row) {
  return { ...row, photos: parseJson(row.photos, []) };
}

function saleRowToJson(db, row) {
  const items = row
    ? db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(row.id)
    : [];
  return { ...row, items };
}

function serializeByEntity(db, entity, row) {
  if (!row) return null;
  if (entity === 'bikes') return bikeRowToJson(row);
  if (entity === 'sales') return saleRowToJson(db, row);
  return { ...row };
}

/** Recalcule total / payment_status d'une vente à partir de ses lignes. */
function recomputeSale(db, saleId, discount, amountPaid) {
  const items = db.prepare('SELECT unit_price, quantity FROM sale_items WHERE sale_id = ?').all(saleId);
  const gross = items.reduce((s, it) => s + it.unit_price * it.quantity, 0);
  const total = gross - (discount || 0);
  const paid = amountPaid === undefined ? db.prepare('SELECT amount_paid FROM sales WHERE id = ?').get(saleId).amount_paid : amountPaid;
  const paymentStatus = paid <= 0 ? 'unpaid' : paid >= total ? 'paid' : 'partial';
  db.prepare('UPDATE sales SET total = ?, amount_paid = ?, payment_status = ? WHERE id = ?')
    .run(total, paid, paymentStatus, saleId);
}

/**
 * Effets de domaine : une vente confirmée/livrée passe les motos en `sold` ;
 * une annulation ou un retour en brouillon les remet en `available`
 * (si aucune autre vente active ne les détient).
 */
function applySaleSideEffects(db, saleId, status) {
  const items = db.prepare('SELECT bike_id FROM sale_items WHERE sale_id = ?').all(saleId);
  for (const it of items) {
    const bike = db.prepare('SELECT id, status, deleted_at FROM bikes WHERE id = ?').get(it.bike_id);
    if (!bike || bike.deleted_at) continue;
    if (status === 'confirme' || status === 'livre') {
      db.prepare("UPDATE bikes SET status = 'sold', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), bike.id);
    } else if (status === 'annule' || status === 'brouillon') {
      const soldByOther = db.prepare(`
        SELECT 1 FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        WHERE si.bike_id = ? AND s.id != ? AND s.deleted_at IS NULL
          AND s.status IN ('confirme', 'livre')
        LIMIT 1
      `).get(bike.id, saleId);
      if (!soldByOther && bike.status === 'sold') {
        db.prepare("UPDATE bikes SET status = 'available', updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), bike.id);
      }
    }
  }
}

/**
 * Applique UNE opération de push. Retourne l'objet de résultat pour la réponse.
 * (À appeler dans une transaction — gérée par pushOperations.)
 */
function applyOperation(db, entity, opIn, ctx) {
  const { user, deviceId } = ctx;
  const base = { index: opIn.index, id: opIn.id, entity, status: 'ok', server: null };

  if (!ENTITIES.includes(entity)) return { ...base, status: 'error', error: 'Entité inconnue : ' + entity };
  const op = opIn.op;
  if (!['create', 'update', 'delete'].includes(op)) return { ...base, status: 'error', error: 'Opération inconnue' };
  if (!opIn.id) return { ...base, status: 'error', error: 'id manquant' };

  // `force` = validation administrative d'un conflit → réservé au rôle admin.
  const force = Boolean(opIn.force) && user.role === 'admin';
  const clientTs = opIn.clientTs || (opIn.payload && opIn.payload.updated_at) || new Date().toISOString();
  const row = db.prepare(`SELECT * FROM ${entity} WHERE id = ?`).get(opIn.id);

  // ---- suppression (tombstone) ----
  if (op === 'delete') {
    if (!row) return { ...base, status: 'ok', deleted: true }; // idempotent
    if (!force && clientTs < row.updated_at) {
      return { ...base, status: 'conflict', server: serializeByEntity(db, entity, row), reason: 'serveur-plus-recent' };
    }
    db.prepare(`UPDATE ${entity} SET deleted_at = ?, updated_at = ?, updated_by = ?, device_id = ? WHERE id = ?`)
      .run(clientTs, clientTs, user.id, deviceId, opIn.id);
    if (entity === 'sales') applySaleSideEffects(db, opIn.id, 'annule');
    return { ...base, status: 'ok', deleted: true };
  }

  // ---- create / update ----
  const payload = opIn.payload || {};
  const pick = {};
  for (const f of ENTITY_FIELDS[entity]) if (payload[f] !== undefined) pick[f] = payload[f];
  if (entity === 'bikes' && pick.photos !== undefined && typeof pick.photos === 'object') {
    pick.photos = JSON.stringify(pick.photos);
  }
  // Vente : le numéro de bon de commande (`BC-AAAA-NNNN`) est attribué par le
  // serveur **à la création uniquement**. `sale_number` ne fait pas partie de
  // ENTITY_FIELDS : sans la garde `!row`, chaque mise à jour d'une vente
  // ré-allouait un numéro (le bon changeait de référence à chaque modification
  // et libérait l'ancien numéro pour une autre vente).
  if (entity === 'sales' && !row && !pick.sale_number) {
    pick.sale_number = allocateSaleNumber(
      db,
      typeof payload.sale_number === 'string' && payload.sale_number ? payload.sale_number : null,
      new Date(payload.sale_date || Date.now()).getFullYear()
    );
  }
  const keys = Object.keys(pick);

  if (!row) {
    const cols = ['id', 'created_at', 'updated_at', 'version', 'created_by', 'updated_by', 'device_id', 'deleted_at'];
    const vals = [opIn.id, payload.created_at || clientTs, clientTs, 1, user.id, user.id, deviceId, payload.deleted_at || null];
    const sql = `INSERT INTO ${entity} (${[...keys, ...cols].join(', ')}) VALUES (${keys.map(() => '?').join(', ')} , ${cols.map(() => '?').join(', ')})`;
    db.prepare(sql).run(...keys.map((k) => pick[k]), ...vals);
  } else {
    // Idempotence : une mise à jour qui ne change aucun champ est toujours « ok »
    // (évite les faux conflits quand le serveur a déjà appliqué le même état,
    // par exemple via l'effet de domaine vente confirmée → moto « vendue »).
    const unchanged = keys.every((k) => String(row[k]) === String(pick[k]));
    if (unchanged) {
      return { ...base, status: 'ok', idempotent: true, server: serializeByEntity(db, entity, row) };
    }
    const wins = clientTs > row.updated_at ||
      (clientTs === row.updated_at && String(deviceId) > String(row.device_id || ''));
    if (!force && !wins) {
      return { ...base, status: 'conflict', server: serializeByEntity(db, entity, row), reason: 'serveur-plus-recent' };
    }
    const setSql = keys.length ? keys.map((k) => `${k} = ?`).join(', ') + ', ' : '';
    db.prepare(`UPDATE ${entity} SET ${setSql}updated_at = ?, updated_by = ?, device_id = ?, version = version + 1 WHERE id = ?`)
      .run(...keys.map((k) => pick[k]), clientTs, user.id, deviceId, opIn.id);
    if (pick.deleted_at === null) db.prepare(`UPDATE ${entity} SET deleted_at = NULL WHERE id = ?`).run(opIn.id);
  }

  // ---- post-traitement des ventes ----
  if (entity === 'sales') {
    let sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(opIn.id);
    if (sale) {
      if (opIn.payload && Array.isArray(opIn.payload.items)) {
        db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(opIn.id);
        const insItem = db.prepare(
          'INSERT INTO sale_items (id, sale_id, bike_id, unit_price, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        for (const it of opIn.payload.items) {
          if (!it || !it.bike_id) continue;
          insItem.run(it.id || crypto.randomUUID(), opIn.id, it.bike_id,
            Number(it.unit_price) || 0, Math.max(1, Number(it.quantity) || 1), clientTs, clientTs);
        }
      }
      recomputeSale(db, opIn.id, pick.discount, pick.amount_paid);
      sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(opIn.id);

      // Numéro de bon : conserver celui proposé s'il est libre, sinon ré-affecter.
      let saleNumber = sale.sale_number;
      const clash = saleNumber && db.prepare('SELECT 1 FROM sales WHERE sale_number = ? AND id != ?').get(saleNumber, opIn.id);
      if (!saleNumber || clash) {
        saleNumber = allocateSaleNumber(db, null, new Date(sale.sale_date || Date.now()).getFullYear());
        db.prepare('UPDATE sales SET sale_number = ? WHERE id = ?').run(saleNumber, opIn.id);
      }
      applySaleSideEffects(db, opIn.id, sale.status);
      base.saleNumber = saleNumber;
    }
  }

  const after = db.prepare(`SELECT * FROM ${entity} WHERE id = ?`).get(opIn.id);
  return { ...base, status: 'ok', server: serializeByEntity(db, entity, after) };
}

/**
 * PUSH : applique un lot d'opérations dans une seule transaction.
 * @returns {{serverTime:string, results:Array}}
 */
function pushOperations(db, { user, deviceId, operations }) {
  let results = [];
  const tx = db.transaction(() => {
    results = operations.map((op, index) => {
      const opIn = { ...op, index };
      try {
        return applyOperation(db, opIn.entity, opIn, { user, deviceId });
      } catch (e) {
        return { index, id: opIn.id, entity: opIn.entity, status: 'error', error: e.message };
      }
    });
  });
  tx();
  return { serverTime: new Date().toISOString(), results };
}

/**
 * PULL : changes depuis `since` (ou tout si absent), paginé par curseur clé.
 * Le curseur encode (updated_at, id) en base64 → pagination sans doublons ni trous.
 */
function pullChanges(db, { since, cursor, limit = 500 }) {
  const maxLimit = Math.min(Number(limit) || 500, 2000);
  let anchorTs = since || '1970-01-01T00:00:00.000Z';
  let anchorId = '';
  if (cursor) {
    try {
      const c = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
      anchorTs = c.u; anchorId = c.i;
    } catch { /* curseur invalide → on repart depuis `since` */ }
  }

  const changes = [];
  for (const entity of ENTITIES) {
    const rows = db.prepare(`
      SELECT * FROM ${entity}
      WHERE (updated_at > ?)
         OR (updated_at = ? AND id > ?)
      ORDER BY updated_at ASC, id ASC
      LIMIT ?
    `).all(anchorTs, anchorTs, anchorId, maxLimit * 3);

    for (const row of rows) {
      const isDeleted = row.deleted_at && row.deleted_at > anchorTs;
      changes.push(isDeleted
        ? { entity, id: row.id, op: 'delete', updatedAt: row.deleted_at, version: row.version, data: { id: row.id, deletedAt: row.deleted_at } }
        : { entity, id: row.id, op: 'upsert', updatedAt: row.updated_at, version: row.version, data: serializeByEntity(db, entity, row) });
    }
  }

  changes.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.id < b.id ? -1 : 1));
  const page = changes.slice(0, maxLimit);
  const more = changes.length > page.length;
  const nextCursor =
    more && page.length > 0
      ? Buffer.from(JSON.stringify({ u: page[page.length - 1].updatedAt, i: page[page.length - 1].id })).toString('base64')
      : null;

  return { serverTime: new Date().toISOString(), changes: page, nextCursor };
}

module.exports = { pushOperations, pullChanges, ENTITY_FIELDS, ENTITIES };
