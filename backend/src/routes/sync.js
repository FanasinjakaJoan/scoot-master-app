'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { pushOperations, pullChanges } = require('../services/sync');

module.exports = function syncRoutes(db) {
  const r = express.Router();
  r.use(requireAuth);

  /**
   * POST /api/sync/push
   * Body : { deviceId: string, operations: [
   *   { entity: 'bikes'|'customers'|'sales', op: 'create'|'update'|'delete',
   *     id: string, payload: object, clientTs: iso8601, force?: boolean }
   * ]}
   *
   * Résolution des conflits : Last-Write-Wins par `clientTs` vs `updated_at` serveur.
   * - status 'ok'        : opération appliquée (ou idempotente)
   * - status 'conflict'  : le serveur est plus récent → renvoyer `server` pour arbitrage ;
   *                        un admin peut renvoyer l'opération avec `force: true` (validation).
   * - status 'error'     : erreur d'application (entité inconnue, FK manquante, etc.)
   */
  r.post('/push', (req, res) => {
    const { deviceId, operations } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: 'deviceId requis.' });
    if (!Array.isArray(operations) || operations.length === 0) {
      return res.status(400).json({ error: 'operations (non vide) requis.' });
    }
    if (operations.length > 500) return res.status(400).json({ error: 'Maximum 500 opérations par push.' });

    const out = pushOperations(db, { user: req.user, deviceId, operations });
    const conflicts = out.results.filter((x) => x.status === 'conflict').length;
    const errors = out.results.filter((x) => x.status === 'error').length;
    res.json({ ...out, stats: { total: out.results.length, ok: out.results.length - conflicts - errors, conflicts, errors } });
  });

  /**
   * GET /api/sync/pull?since=<iso8601>&cursor=<opaque>&limit=<1..2000>
   * Renvoie les changements serveur depuis `since` (créations, modifications, suppressions).
   * `nextCursor` : à renvoyer tant que non null pour vider la file.
   */
  r.get('/pull', (req, res) => {
    const { since, cursor, limit } = req.query;
    const out = pullChanges(db, { since: since || undefined, cursor: cursor || undefined, limit: Number(limit) || 500 });
    res.json(out);
  });

  /** GET /api/sync/status — état global (pour l'indicateur de l'app). */
  r.get('/status', (req, res) => {
    res.json({
      serverTime: new Date().toISOString(),
      counts: {
        bikes: db.prepare("SELECT COUNT(*) AS n FROM bikes WHERE deleted_at IS NULL").get().n,
        customers: db.prepare('SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL').get().n,
        sales: db.prepare('SELECT COUNT(*) AS n FROM sales WHERE deleted_at IS NULL').get().n,
      },
    });
  });

  return r;
};
