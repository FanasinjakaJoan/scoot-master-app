'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAuth, requireRole } = require('../middleware/auth');
const { toCsv } = require('../util/csv');
const { nowIso } = require('../util/ids');

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

  const rows = (entity, includeDeleted = false) =>
    db.prepare(`SELECT * FROM ${entity} ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'}`)
      .all()
      .map((row) => (entity === 'bikes' ? { ...row, photos: safeJson(row.photos).length + ' photo(s)' } : row));

  /** GET /api/exports/backup — sauvegarde complète (toutes entités, JSON). */
  r.get('/backup', (req, res) => {
    const backup = {
      app: 'scoot-master',
      version: 1,
      exportedAt: nowIso(),
      bikes: rows('bikes', true),
      customers: rows('customers', true),
      sales: db.prepare('SELECT * FROM sales').all().map((s) => ({
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

  /** GET /api/exports/:entity?format=json|csv — bikes | customers | sales */
  r.get('/:entity', (req, res) => {
    const { entity } = req.params;
    const format = req.query.format === 'csv' ? 'csv' : 'json';
    if (!ENTITY_COLUMNS[entity]) return res.status(404).json({ error: 'Entité inconnue (bikes, customers, sales).' });

    if (format === 'csv') {
      const csv = toCsv(rows(entity), ENTITY_COLUMNS[entity]);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="scoot-${entity}-${stamp()}.csv"`);
      return res.send(csv);
    }
    const json = JSON.stringify({ exportedAt: nowIso(), entity, rows: rows(entity) }, null, 2);
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
