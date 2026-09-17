'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { uuid, nowIso } = require('../util/ids');
const { allocateSaleNumber } = require('../util/ids');

module.exports = function saleRoutes(db) {
  const r = express.Router();
  r.use(requireAuth);

  /** GET /api/sales?status=&customerId=&from=&to=&page=&limit= */
  r.get('/', (req, res) => {
    const { status, customerId, from, to, page = 1, limit = 50 } = req.query;
    const where = ['s.deleted_at IS NULL'];
    const args = [];
    if (status) { where.push('s.status = ?'); args.push(status); }
    if (customerId) { where.push('s.customer_id = ?'); args.push(customerId); }
    if (from) { where.push('s.sale_date >= ?'); args.push(from); }
    if (to) { where.push('s.sale_date <= ?'); args.push(to); }
    const lim = Math.min(Number(limit) || 50, 200);
    const off = (Math.max(1, Number(page) || 1) - 1) * lim;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM sales s WHERE ${where.join(' AND ')}`).get(...args).n;
    const rows = db.prepare(`
      SELECT s.*, c.first_name, c.last_name, c.phone
      FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
      WHERE ${where.join(' AND ')}
      ORDER BY s.sale_date DESC, s.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...args, lim, off);
    const itemStmt = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?');
    const bikeStmt = db.prepare('SELECT id, brand, model FROM bikes WHERE id = ?');
    res.json({
      total, page: Number(page), limit: lim,
      items: rows.map((s) => ({
        ...s,
        customer: s.customer_id ? { id: s.customer_id, first_name: s.first_name, last_name: s.last_name, phone: s.phone } : null,
        items: itemStmt.all(s.id).map((it) => ({ ...it, bike: bikeStmt.get(it.bike_id) || null })),
      })),
    });
  });

  r.get('/:id', (req, res) => {
    const s = db.prepare(`
      SELECT s.*, c.first_name, c.last_name, c.phone
      FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.id = ? AND s.deleted_at IS NULL
    `).get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Vente introuvable.' });
    const itemStmt = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?');
    const bikeStmt = db.prepare('SELECT id, brand, model, price FROM bikes WHERE id = ?');
    res.json({
      sale: {
        ...s,
        customer: s.customer_id ? { id: s.customer_id, first_name: s.first_name, last_name: s.last_name, phone: s.phone } : null,
        items: itemStmt.all(s.id).map((it) => ({ ...it, bike: bikeStmt.get(it.bike_id) || null })),
      },
    });
  });

  /** POST /api/sales — {customer_id, items:[{bike_id, unit_price, quantity}], discount, amount_paid, payment_method, status, sale_date, notes} */
  r.post('/', (req, res) => {
    const d = req.body || {};
    if (!d.customer_id) return res.status(400).json({ error: 'client_id requis.' });
    if (!Array.isArray(d.items) || !d.items.length) return res.status(400).json({ error: 'Au moins une ligne de vente requise.' });
    const customer = db.prepare('SELECT id FROM customers WHERE id = ? AND deleted_at IS NULL').get(d.customer_id);
    if (!customer) return res.status(400).json({ error: 'Client introuvable.' });

    const ts = nowIso();
    const id = d.id || uuid();
    const saleNumber = d.sale_number || allocateSaleNumber(db, null, new Date(d.sale_date || Date.now()).getFullYear());
    const status = d.status || 'brouillon';
    const saleDate = d.sale_date || new Date().toISOString().slice(0, 10);

    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO sales (id, sale_number, customer_id, total, discount, amount_paid, payment_method,
          payment_status, status, sale_date, notes, created_at, updated_at, version, created_by, updated_by, device_id)
        VALUES (?, ?, ?, 0, ?, ?, ?, 'unpaid', ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(id, saleNumber, d.customer_id, d.discount || 0, d.amount_paid || 0,
        d.payment_method || 'cash', status, saleDate, d.notes || null, ts, ts, req.user.id, req.user.id, req.user.deviceId || null);

      const insItem = db.prepare(
        'INSERT INTO sale_items (id, sale_id, bike_id, unit_price, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      let gross = 0;
      for (const it of d.items) {
        const bike = db.prepare('SELECT id FROM bikes WHERE id = ? AND deleted_at IS NULL').get(it.bike_id);
        if (!bike) throw Object.assign(new Error('Moto introuvable : ' + it.bike_id), { status: 400 });
        const qty = Math.max(1, Number(it.quantity) || 1);
        const price = Number(it.unit_price) || 0;
        insItem.run(it.id || uuid(), id, it.bike_id, price, qty, ts, ts);
        gross += price * qty;
      }
      const total = gross - (d.discount || 0);
      const paid = d.amount_paid || 0;
      const paymentStatus = paid <= 0 ? 'unpaid' : paid >= total ? 'paid' : 'partial';
      db.prepare('UPDATE sales SET total = ?, payment_status = ? WHERE id = ?').run(total, paymentStatus, id);

      if (status === 'confirme' || status === 'livre') {
        for (const it of d.items) {
          db.prepare("UPDATE bikes SET status = 'sold', updated_at = ? WHERE id = ?").run(ts, it.bike_id);
        }
      }
    });
    tx();

    const after = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
    res.status(201).json({ sale: { ...after, items: db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(id) } });
  });

  /** PUT /api/sales/:id — mise à jour (statut, paiement, notes, lignes). */
  r.put('/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Vente introuvable.' });
    const d = req.body || {};

    const tx = db.transaction(() => {
      const fields = [];
      const args = [];
      for (const k of ['status', 'payment_method', 'payment_status', 'amount_paid', 'discount', 'sale_date', 'notes']) {
        if (d[k] !== undefined) { fields.push(`${k} = ?`); args.push(d[k]); }
      }
      if (fields.length) {
        fields.push('updated_at = ?', 'updated_by = ?', 'version = version + 1');
        args.push(nowIso(), req.user.id, req.params.id);
        db.prepare(`UPDATE sales SET ${fields.join(', ')} WHERE id = ?`).run(...args);
      }
      if (Array.isArray(d.items)) {
        db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(req.params.id);
        const insItem = db.prepare(
          'INSERT INTO sale_items (id, sale_id, bike_id, unit_price, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        const ts = nowIso();
        for (const it of d.items) {
          insItem.run(it.id || uuid(), req.params.id, it.bike_id, Number(it.unit_price) || 0, Math.max(1, Number(it.quantity) || 1), ts, ts);
        }
      }
      // Recalcul du total + effet de domaine sur les motos
      const s = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
      const items = db.prepare('SELECT unit_price, quantity FROM sale_items WHERE sale_id = ?').all(req.params.id);
      const total = items.reduce((sum, it) => sum + it.unit_price * it.quantity, 0) - (s.discount || 0);
      db.prepare('UPDATE sales SET total = ? WHERE id = ?').run(total, req.params.id);
      const soldBy = db.prepare('SELECT bike_id FROM sale_items WHERE sale_id = ?').all(req.params.id);
      for (const it of soldBy) {
        if (s.status === 'confirme' || s.status === 'livre') {
          db.prepare("UPDATE bikes SET status = 'sold', updated_at = ? WHERE id = ?").run(nowIso(), it.bike_id);
        } else if (s.status === 'annule' || s.status === 'brouillon') {
          const other = db.prepare(`
            SELECT 1 FROM sale_items si JOIN sales s2 ON s2.id = si.sale_id
            WHERE si.bike_id = ? AND s2.id != ? AND s2.deleted_at IS NULL AND s2.status IN ('confirme','livre') LIMIT 1
          `).get(it.bike_id, req.params.id);
          if (!other) {
            db.prepare("UPDATE bikes SET status = 'available', updated_at = ? WHERE id = ?").run(nowIso(), it.bike_id);
          }
        }
      }
    });
    tx();

    const after = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
    res.json({ sale: { ...after, items: db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(req.params.id) } });
  });

  /** DELETE /api/sales/:id (admin uniquement) — suppression logique, motos remises en stock. */
  r.delete('/:id', requireRole('admin'), (req, res) => {
    const row = db.prepare('SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Vente introuvable.' });
    const tx = db.transaction(() => {
      db.prepare('UPDATE sales SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ?')
        .run(nowIso(), nowIso(), req.user.id, req.params.id);
      for (const it of db.prepare('SELECT bike_id FROM sale_items WHERE sale_id = ?').all(req.params.id)) {
        const other = db.prepare(`
          SELECT 1 FROM sale_items si JOIN sales s2 ON s2.id = si.sale_id
          WHERE si.bike_id = ? AND s2.deleted_at IS NULL AND s2.status IN ('confirme','livre') LIMIT 1
        `).get(it.bike_id);
        if (!other) db.prepare("UPDATE bikes SET status = 'available', updated_at = ? WHERE id = ?").run(nowIso(), it.bike_id);
      }
    });
    tx();
    res.json({ ok: true });
  });

  return r;
};
