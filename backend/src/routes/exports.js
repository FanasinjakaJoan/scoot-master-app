'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAuth, requireRole } = require('../middleware/auth');
const { toCsv } = require('../util/csv');
const { nowIso } = require('../util/ids');
const { appendOwnerFilter, audit } = require('../security/rls');
const { config } = require('../config');
const { backupToDrive } = require('../services/backup');
const { GoogleDriveClient } = require('../services/google-drive');

const STORAGE_DIR = path.join(__dirname, '..', '..', 'storage', 'backups');

const ENTITY_COLUMNS = {
  bikes: [
    { key: 'id', header: 'ID' }, { key: 'brand', header: 'Marque' }, { key: 'model', header: 'Modèle' },
    { key: 'year', header: 'Année' }, { key: 'mileage_km', header: 'Kilométrage' }, { key: 'engine_cc', header: 'Cylindrée (cc)' },
    { key: 'color', header: 'Couleur' }, { key: 'serial_number', header: 'N° série' }, { key: 'price', header: 'Prix' },
    { key: 'currency', header: 'Devise' }, { key: 'mechanical_state', header: 'État mécanique (1-5)' },
    { key: 'aesthetic_state', header: 'État esthétique (1-5)' }, { key: 'status', header: 'Statut' },
    { key: 'warehouse', header: 'Magasin' }, { key: 'description', header: 'Description' },
    { key: 'updated_at', header: 'Mis à jour le' },
  ],
  customers: [
    { key: 'id', header: 'ID' }, { key: 'first_name', header: 'Prénom' }, { key: 'last_name', header: 'Nom' },
    { key: 'phone', header: 'Téléphone' }, { key: 'email', header: 'Email' }, { key: 'address', header: 'Adresse' },
    { key: 'notes', header: 'Notes' }, { key: 'updated_at', header: 'Mis à jour le' },
  ],
  sales: [
    { key: 'id', header: 'ID' }, { key: 'sale_number', header: 'N° bon' }, { key: 'customer_id', header: 'Client ID' },
    { key: 'total', header: 'Total' }, { key: 'discount', header: 'Remise' }, { key: 'amount_paid', header: 'Payé' },
    { key: 'payment_method', header: 'Paiement' }, { key: 'payment_status', header: 'Statut paiement' },
    { key: 'status', header: 'Statut' }, { key: 'sale_date', header: 'Date' }, { key: 'notes', header: 'Notes' },
  ],
};

module.exports = function exportRoutes(db) {
  const r = express.Router();
  r.use(requireAuth);

  /**
   * Lignes visibles par l'utilisateur pour une entité (isolation des données) :
   * un vendeur n'exporte que SES lignes ; l'admin exporte tout.
   */
  const rows = (req, entity, includeDeleted = false) => {
    const where = [];
    const args = [];
    if (!includeDeleted) where.push('deleted_at IS NULL');
    appendOwnerFilter(req, where, args);
    const sql = `SELECT * FROM ${entity}${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
    return db.prepare(sql)
      .all(...args)
      .map((row) => (entity === 'bikes' ? { ...row, photos: safeJson(row.photos).length + ' photo(s)' } : row));
  };

  /** GET /api/exports/backup — sauvegarde complète (périmètre de l'utilisateur, JSON). */
  r.get('/backup', (req, res) => {
    const salesWhere = [];
    const salesArgs = [];
    appendOwnerFilter(req, salesWhere, salesArgs);
    const backup = {
      app: 'scoot-master',
      version: 1,
      exportedAt: nowIso(),
      bikes: rows(req, 'bikes', true),
      customers: rows(req, 'customers', true),
      sales: db.prepare(`SELECT * FROM sales${salesWhere.length ? ' WHERE ' + salesWhere.join(' AND ') : ''}`).all(...salesArgs).map((s) => ({
        ...s,
        items: db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(s.id),
      })),
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="scoot-backup-${stamp()}.json"`);
    res.send(JSON.stringify(backup, null, 2));
  });

  /** POST /api/exports/backup — téléversement d'une sauvegarde locale (stockage serveur). */
  r.post('/backup', (req, res) => {
    const data = req.body && req.body.data;
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Corps JSON {data: {...}} requis.' });
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    const file = path.join(STORAGE_DIR, `backup-${stamp()}-${sanitize(req.body.fileName || 'local')}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    res.status(201).json({ ok: true, file: path.basename(file) });
  });

  /**
   * GET /api/exports/backups — liste des sauvegardes téléversées (admin).
   * ⚠️ Doit être déclarée AVANT `/:entity`, sinon le motif `:entity` capte
   * « backups » et renvoie « Entité inconnue » (route injoignable).
   */
  r.get('/backups', requireRole('admin'), (req, res) => {
    if (!fs.existsSync(STORAGE_DIR)) return res.json({ items: [] });
    const items = fs.readdirSync(STORAGE_DIR).map((f) => {
      const st = fs.statSync(path.join(STORAGE_DIR, f));
      return { file: f, size: st.size, createdAt: st.mtime.toISOString() };
    });
    res.json({ items: items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) });
  });

  /**
   * POST /api/exports/backup/drive — déclenche une sauvegarde vers Google Drive
   * (admin uniquement). Ignore l'isolation par `owner_id` : c'est une sauvegarde
   * d'infrastructure qui emporte TOUTES les données.
   *
   * Destiné aussi à un CRON externe (Render Cron Job / GitHub Actions) qui
   * appellerait cette route avec un jeton admin.
   *
   * ⚠️ Déclarée AVANT `/:entity` (sinon « backup » serait capté et renverrait 404).
   */
  r.post('/backup/drive', requireRole('admin'), async (req, res, next) => {
    try {
      const result = await backupToDrive(db, {
        format: (req.body && req.body.format) || config.backup.format,
        exportedBy: req.user.id,
      });
      audit(db, { req, action: 'backup.drive', entity: null, entityId: result.file.id, details: { name: result.name, size: result.size } });
      res.status(201).json(result);
    } catch (e) {
      if (e && e.name === 'GoogleDriveError') {
        return res.status(502).json({ error: e.message, drive: e.body || null });
      }
      next(e);
    }
  });

  /** GET /api/exports/backup/drive — liste les sauvegardes présentes sur Drive (admin). */
  r.get('/backup/drive', requireRole('admin'), async (req, res, next) => {
    try {
      const client = new GoogleDriveClient();
      if (!client.configured) {
        return res.status(503).json({ error: 'Compte de service Google non configuré (GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY).' });
      }
      const files = await client.listFiles({ max: Number(req.query.limit) || 50 });
      res.json({ items: files });
    } catch (e) {
      if (e && e.name === 'GoogleDriveError') {
        return res.status(502).json({ error: e.message, drive: e.body || null });
      }
      next(e);
    }
  });

  /**
   * GET /api/exports/audit — journal d'audit (admin uniquement).
   * Filtres : `?action=`, `?entity=`, `?actor=`, `?limit=` (défaut 200, max 1000).
   */
  r.get('/audit', requireRole('admin'), (req, res) => {
    const where = [];
    const args = [];
    if (req.query.action) { where.push('action = ?'); args.push(String(req.query.action)); }
    if (req.query.entity) { where.push('entity = ?'); args.push(String(req.query.entity)); }
    if (req.query.actor) { where.push('actor_id = ?'); args.push(String(req.query.actor)); }
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 200, 1000));
    const sql = `SELECT * FROM audit_log${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    const items = db.prepare(sql).all(...args, limit).map((row) => ({
      ...row,
      adminAccess: row.admin_access === 1,
      details: row.details ? JSON.parse(row.details) : null,
    }));
    res.json({ items });
  });

  /** GET /api/exports/:entity?format=json|csv — bikes | customers | sales */
  r.get('/:entity', (req, res) => {
    const { entity } = req.params;
    const format = req.query.format === 'csv' ? 'csv' : 'json';
    if (!ENTITY_COLUMNS[entity]) return res.status(404).json({ error: 'Entité inconnue (bikes, customers, sales).' });

    if (format === 'csv') {
      const csv = toCsv(rows(req, entity), ENTITY_COLUMNS[entity]);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="scoot-${entity}-${stamp()}.csv"`);
      return res.send(csv);
    }
    const json = JSON.stringify({ exportedAt: nowIso(), entity, rows: rows(req, entity) }, null, 2);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="scoot-${entity}-${stamp()}.json"`);
    res.send(json);
  });

  return r;
};

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 40) || 'export';
}
function safeJson(v) { try { return JSON.parse(v); } catch { return []; } }
