'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { uuid, nowIso } = require('../util/ids');
const { appendOwnerFilter, findScoped, ownerForCreate, audit } = require('../security/rls');

module.exports = function bikeRoutes(db) {
  const r = express.Router();
  r.use(requireAuth);

  /** GET /api/bikes?status=&brand=&q=&minPrice=&maxPrice=&sort=&order=&page=&limit= */
  r.get('/', (req, res) => {
    const { status, brand, q, minPrice, maxPrice, sort = 'updated_at', order = 'desc', page = 1, limit = 50 } = req.query;
    const where = ['deleted_at IS NULL'];
    const args = [];
    if (status) { where.push('status = ?'); args.push(status); }
    if (brand) { where.push('brand = ?'); args.push(brand); }
    if (q) {
      where.push('(brand LIKE ? OR model LIKE ? OR serial_number LIKE ? OR description LIKE ?)');
      const like = `%${q}%`;
      args.push(like, like, like, like);
    }
    if (minPrice) { where.push('price >= ?'); args.push(Number(minPrice)); }
    if (maxPrice) { where.push('price <= ?'); args.push(Number(maxPrice)); }
    // Isolation : un vendeur ne voit que SES motos ; l'admin voit tout.
    appendOwnerFilter(req, where, args);
    const allowedSorts = { updated_at: 'updated_at', price: 'price', mileage_km: 'mileage_km', brand: 'brand', model: 'model' };
    const sortCol = allowedSorts[sort] || 'updated_at';
    const dir = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const lim = Math.min(Number(limit) || 50, 200);
    const off = (Math.max(1, Number(page) || 1) - 1) * lim;

    const total = db.prepare(`SELECT COUNT(*) AS n FROM bikes WHERE ${where.join(' AND ')}`).get(...args).n;
    const items = db.prepare(`
      SELECT * FROM bikes WHERE ${where.join(' AND ')}
      ORDER BY ${sortCol} ${dir}, id ${dir}
      LIMIT ? OFFSET ?
    `).all(...args, lim, off);

    res.json({ items: items.map((b) => ({ ...b, photos: safeJson(b.photos) })), total, page: Number(page), limit: lim });
  });

  /** GET /api/bikes/meta — marques et statuts disponibles (pour les filtres). */
  r.get('/meta', (req, res) => {
    const where = ['deleted_at IS NULL'];
    const args = [];
    appendOwnerFilter(req, where, args);
    const brands = db.prepare(`SELECT DISTINCT brand FROM bikes WHERE ${where.join(' AND ')} ORDER BY brand`).all(...args).map((x) => x.brand);
    const statuses = ['available', 'reserved', 'maintenance', 'sold'];
    res.json({ brands, statuses });
  });

  r.get('/:id', (req, res) => {
    const row = findScoped(db, req, 'bikes', req.params.id, 'deleted_at IS NULL');
    if (!row) return res.status(404).json({ error: 'Moto introuvable.' });
    res.json({ bike: { ...row, photos: safeJson(row.photos) } });
  });

  /** POST /api/bikes — création (admin ou vendeur). Le propriétaire est l'appelant. */
  r.post('/', (req, res) => {
    const b = validate(req.body);
    if (!b.ok) return res.status(400).json({ error: b.error });
    const ts = nowIso();
    const id = b.data.id || uuid();
    const ownerId = ownerForCreate(req, b.data.owner_id);
    db.prepare(`
      INSERT INTO bikes (id, brand, model, year, mileage_km, engine_cc, color, serial_number, price, currency,
        mechanical_state, aesthetic_state, status, description, warehouse, photos,
        created_at, updated_at, version, created_by, updated_by, owner_id, device_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      id, b.data.brand, b.data.model, b.data.year ?? null, b.data.mileage_km ?? 0, b.data.engine_cc ?? null,
      b.data.color || null, b.data.serial_number || null, b.data.price, b.data.currency || 'MGA',
      b.data.mechanical_state ?? 3, b.data.aesthetic_state ?? 3, b.data.status || 'available',
      b.data.description || null, b.data.warehouse || null, JSON.stringify(b.data.photos || []),
      ts, ts, req.user.id, req.user.id, ownerId, req.user.deviceId || null
    );
    const row = db.prepare('SELECT * FROM bikes WHERE id = ?').get(id);
    audit(db, { req, action: 'bike.create', entity: 'bikes', entityId: id, ownerId });
    res.status(201).json({ bike: { ...row, photos: safeJson(row.photos) } });
  });

  /** PUT /api/bikes/:id — mise à jour partielle (propriétaire ou admin). */
  r.put('/:id', (req, res) => {
    const row = findScoped(db, req, 'bikes', req.params.id, 'deleted_at IS NULL');
    if (!row) return res.status(404).json({ error: 'Moto introuvable.' });
    const b = validate(req.body, true);
    if (!b.ok) return res.status(400).json({ error: b.error });
    const fields = [];
    const args = [];
    for (const k of ['brand', 'model', 'year', 'mileage_km', 'engine_cc', 'color', 'serial_number', 'price', 'currency', 'mechanical_state', 'aesthetic_state', 'status', 'description', 'warehouse']) {
      if (b.data[k] !== undefined) { fields.push(`${k} = ?`); args.push(b.data[k]); }
    }
    if (b.data.photos !== undefined) { fields.push('photos = ?'); args.push(JSON.stringify(b.data.photos)); }
    if (!fields.length) return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    fields.push('updated_at = ?', 'updated_by = ?', 'version = version + 1');
    args.push(nowIso(), req.user.id, req.params.id);
    db.prepare(`UPDATE bikes SET ${fields.join(', ')} WHERE id = ?`).run(...args);
    const after = db.prepare('SELECT * FROM bikes WHERE id = ?').get(req.params.id);
    audit(db, { req, action: 'bike.update', entity: 'bikes', entityId: req.params.id, ownerId: row.owner_id });
    res.json({ bike: { ...after, photos: safeJson(after.photos) } });
  });

  /** DELETE /api/bikes/:id — suppression logique (admin uniquement, toutes les données). */
  r.delete('/:id', requireRole('admin'), (req, res) => {
    const row = findScoped(db, req, 'bikes', req.params.id, 'deleted_at IS NULL');
    if (!row) return res.status(404).json({ error: 'Moto introuvable.' });
    db.prepare('UPDATE bikes SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(nowIso(), nowIso(), req.user.id, req.params.id);
    audit(db, { req, action: 'bike.delete', entity: 'bikes', entityId: req.params.id, ownerId: row.owner_id, details: { byAdmin: true } });
    res.json({ ok: true });
  });

  return r;
};

function validate(body, partial = false) {
  const d = body || {};
  const errors = [];
  if (!partial || d.brand !== undefined) if (!d.brand) errors.push('marque requise');
  if (!partial || d.model !== undefined) if (!d.model) errors.push('modèle requis');
  if (d.price !== undefined && (!Number.isFinite(Number(d.price)) || Number(d.price) < 0)) errors.push('prix invalide');
  if (d.mileage_km !== undefined && (!Number.isFinite(Number(d.mileage_km)) || Number(d.mileage_km) < 0)) errors.push('kilométrage invalide');
  if (errors.length) return { ok: false, error: errors.join('; ') };
  return { ok: true, data: d };
}

function safeJson(v) { try { return JSON.parse(v); } catch { return []; } }
