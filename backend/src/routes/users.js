'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { requireAuth, requireRole } = require('../middleware/auth');
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();

// Administration centralisée : toutes les opérations sont protégées côté serveur.
module.exports = function userRoutes(db) {
  const r = express.Router();
  r.use(requireAuth);
  r.get('/', requireRole('admin'), (req, res) => {
    const users = db.prepare('SELECT id, username, full_name AS fullName, role, created_at AS createdAt, updated_at AS updatedAt, deleted_at IS NULL AS active FROM users ORDER BY username').all();
    res.json({ users });
  });
  r.post('/', requireRole('admin'), (req, res) => {
    const { username, password, fullName, role = 'seller' } = req.body || {};
    if (!username || !password || !fullName || !['admin', 'seller'].includes(role) || String(password).length < 8) return res.status(400).json({ error: 'Nom, nom complet, rôle valide et mot de passe de 8 caractères minimum requis.' });
    try {
      const ts = now();
      const user = { id: id(), username: String(username).trim(), fullName: String(fullName).trim(), role };
      db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(user.id, user.username, bcrypt.hashSync(String(password), 12), user.fullName, role, ts, ts);
      res.status(201).json({ user });
    } catch { res.status(409).json({ error: 'Nom d’utilisateur déjà utilisé.' }); }
  });
  r.patch('/:id', (req, res) => {
    if (req.user.role !== 'admin' && req.user.id !== req.params.id) return res.status(403).json({ error: 'Droits insuffisants.' });
    const { fullName, role, password, active } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    if (u.id === req.user.id && active === false) return res.status(400).json({ error: 'Impossible de désactiver sa propre session.' });
    const ts = now();
    db.prepare('UPDATE users SET full_name = COALESCE(?, full_name), role = COALESCE(?, role), password_hash = COALESCE(?, password_hash), deleted_at = ?, updated_at = ? WHERE id = ?')
      .run(fullName || null, role && ['admin','seller'].includes(role) ? role : null, password && String(password).length >= 8 ? bcrypt.hashSync(String(password), 12) : null, active === false ? ts : null, ts, u.id);
    res.json({ ok: true });
  });
  return r;
};
