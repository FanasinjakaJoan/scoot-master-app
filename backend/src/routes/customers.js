'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { uuid, nowIso } = require('../util/ids');
const { appendOwnerFilter, findScoped, ownerForCreate, audit } = require('../security/rls');

module.exports = function customerRoutes(db) {
  const r = express.Router();
  r.use(requireAuth);

  /** GET /api/customers?q=&page=&limit= */
  r.get('/', (req, res) => {
    const { q, page = 1, limit = 50 } = req.query;
    // Isolation : agrégats d'achats calculés uniquement sur les ventes visibles.
    const where = ['c.deleted_at IS NULL'];
    const args = [];
    if (q) {
      where.push('(c.first_name LIKE ? OR c.last_name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)');
      const like = `%${q}%`;
      args.push(like, like, like, like);
    }
    appendOwnerFilter(req, where, args, 'c');
    const lim = Math.min(Number(limit) || 50, 200);
    const off = (Math.max(1, Number(page) || 1) - 1) * lim;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM customers c WHERE ${where.join(' AND ')}`).get(...args).n;
    const items = db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id AND s.deleted_at IS NULL) AS nb_sales,
        (SELECT COALESCE(SUM(s.total), 0) FROM sales s WHERE s.customer_id = c.id AND s.deleted_at IS NULL) AS total_spent
      FROM customers c WHERE ${where.join(' AND ')}
      ORDER BY c.last_name, c.first_name
      LIMIT ? OFFSET ?
    `).all(...args, lim, off);
    res.json({ items, total, page: Number(page), limit: lim });
  });

  r.get('/:id', (req, res) => {
    const row = findScoped(db, req, 'customers', req.params.id, 'deleted_at IS NULL');
    if (!row) return res.status(404).json({ error: 'Client introuvable.' });
    res.json({ customer: row });
  });

  /** GET /api/customers/:id/purchases — historique des achats du client. */
  r.get('/:id/purchases', (req, res) => {
    const row = findScoped(db, req, 'customers', req.params.id, 'deleted_at IS NULL');
    if (!row) return res.status(404).json({ error: 'Client introuvable.' });
    const sales = db.prepare(`
      SELECT s.* FROM sales s WHERE s.customer_id = ? AND s.deleted_at IS NULL ORDER BY s.sale_date DESC
    `).all(req.params.id);
    const itemStmt = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?');
    const bikeStmt = db.prepare('SELECT id, brand, model FROM bikes WHERE id = ?');
    res.json({
      sales: sales.map((s) => ({
        ...s,
        items: itemStmt.all(s.id).map((it) => ({ ...it, bike: bikeStmt.get(it.bike_id) || null })),
      })),
    });
  });

  /** POST /api/customers — le propriétaire est l'appelant. */
  r.post('/', (req, res) => {
    const d = req.body || {};
    if (!d.first_name || !d.last_name || !d.phone) {
      return res.status(400).json({ error: 'Nom, prénom et téléphone requis.' });
    }
    const ts = nowIso();
    const id = d.id || uuid();
    const ownerId = ownerForCreate(req, d.owner_id);
    db.prepare(`
      INSERT INTO customers (id, first_name, last_name, phone, email, address, notes,
        created_at, updated_at, version, created_by, updated_by, owner_id, device_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(id, d.first_name, d.last_name, d.phone, d.email || null, d.address || null, d.notes || null,
      ts, ts, req.user.id, req.user.id, ownerId, req.user.deviceId || null);
    const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    audit(db, { req, action: 'customer.create', entity: 'customers', entityId: id, ownerId });
    res.status(201).json({ customer: row });
  });

  /** PUT /api/customers/:id — propriétaire ou admin. */
  r.put('/:id', (req, res) => {
    const row = findScoped(db, req, 'customers', req.params.id, 'deleted_at IS NULL');
    if (!row) return res.status(404).json({ error: 'Client introuvable.' });
    const d = req.body || {};
    const fields = [];
    const args = [];
    for (const k of ['first_name', 'last_name', 'phone', 'email', 'address', 'notes']) {
      if (d[k] !== undefined) { fields.push(`${k} = ?`); args.push(d[k]); }
    }
    if (!fields.length) return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    fields.push('updated_at = ?', 'updated_by = ?', 'version = version + 1');
    args.push(nowIso(), req.user.id, req.params.id);
    db.prepare(`UPDATE customers SET ${fields.join(', ')} WHERE id = ?`).run(...args);
    const after = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    audit(db, { req, action: 'customer.update', entity: 'customers', entityId: req.params.id, ownerId: row.owner_id });
    res.json({ customer: after });
  });

  /** DELETE /api/customers/:id (admin uniquement) */
  r.delete('/:id', requireRole('admin'), (req, res) => {
    const row = findScoped(db, req, 'customers', req.params.id, 'deleted_at IS NULL');
    if (!row) return res.status(404).json({ error: 'Client introuvable.' });
    db.prepare('UPDATE customers SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(nowIso(), nowIso(), req.user.id, req.params.id);
    audit(db, { req, action: 'customer.delete', entity: 'customers', entityId: req.params.id, ownerId: row.owner_id, details: { byAdmin: true } });
    res.json({ ok: true });
  });

  return r;
};
