'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { requireAuth, requireRole } = require('../middleware/auth');
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();

const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  fullName: u.full_name,
  role: u.role,
  active: u.deleted_at == null,
  createdAt: u.created_at,
  updatedAt: u.updated_at,
});

// Administration centralisée : toutes les opérations sont protégées côté serveur.
module.exports = function userRoutes(db) {
  const r = express.Router();
  r.use(requireAuth);

  /** GET /api/users — liste globale (admin uniquement). */
  r.get('/', requireRole('admin'), (req, res) => {
    const users = db.prepare('SELECT * FROM users ORDER BY username').all().map(publicUser);
    res.json({ users });
  });

  /** POST /api/users — créer un utilisateur (admin uniquement). */
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

  /**
   * PATCH /api/users/profile — MON profil (tout utilisateur authentifié).
   * Auto-service restreint : uniquement `fullName` et `password`. Toute
   * tentative de changer `role` ou `active` par cette voie est refusée (403).
   * Déclarée AVANT `/:id` pour ne pas être capturée par ce motif.
   */
  r.patch('/profile', (req, res) => {
    const { fullName, password } = req.body || {};
    if (fullName === undefined && password === undefined) {
      return res.status(400).json({ error: 'Rien à mettre à jour (fullName et/ou password attendus).' });
    }
    if (fullName !== undefined && (!String(fullName).trim())) {
      return res.status(400).json({ error: 'Le nom complet ne peut pas être vide.' });
    }
    if (password !== undefined && String(password).length < 8) {
      return res.status(400).json({ error: 'Mot de passe de 8 caractères minimum requis.' });
    }
    const ts = now();
    db.prepare('UPDATE users SET full_name = COALESCE(?, full_name), password_hash = COALESCE(?, password_hash), updated_at = ? WHERE id = ?')
      .run(fullName !== undefined ? String(fullName).trim() : null,
        password !== undefined ? bcrypt.hashSync(String(password), 12) : null,
        ts, req.user.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ ok: true, user: publicUser(u) });
  });

  /** Adapter commun à PATCH et PUT /:id. */
  function adminOrSelfPatch(req, res) {
    if (req.params.id === 'profile') {
      // Jamais atteint en PATCH (route déclarée avant) ; garde défensive pour PUT.
      return res.status(400).json({ error: 'Utilisez PATCH /api/users/profile pour modifier votre propre profil.' });
    }
    const isSelf = req.user.id === req.params.id;
    const isAdmin = req.user.role === 'admin';
    if (!isAdmin && !isSelf) {
      return res.status(403).json({ error: 'Droits insuffisants : vous ne pouvez modifier que votre propre profil.' });
    }

    const { fullName, role, password, active } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) return res.status(404).json({ error: 'Utilisateur introuvable.' });

    // RBAC : rôle et statut (activation) sont réservés aux administrateurs.
    if (!isAdmin && (role !== undefined || active !== undefined)) {
      return res.status(403).json({ error: 'Seuls les administrateurs peuvent changer le rôle ou le statut d’un compte.' });
    }
    // Anti-verrouillage : un admin ne change pas son propre rôle et ne se désactive pas.
    if (isSelf && role !== undefined && role !== u.role) {
      return res.status(400).json({ error: 'Impossible de modifier son propre rôle.' });
    }
    if (isSelf && active === false) {
      return res.status(400).json({ error: 'Impossible de désactiver son propre compte.' });
    }
    if (role !== undefined && !['admin', 'seller'].includes(role)) {
      return res.status(400).json({ error: 'Rôle invalide (admin ou seller).' });
    }
    if (password !== undefined && String(password).length < 8) {
      return res.status(400).json({ error: 'Mot de passe de 8 caractères minimum requis.' });
    }
    if (fullName !== undefined && !String(fullName).trim()) {
      return res.status(400).json({ error: 'Le nom complet ne peut pas être vide.' });
    }

    const ts = now();
    // `deleted_at` n'est modifié QUE si `active` est fourni explicitement :
    // une édition ordinaire ne doit jamais réactiver un compte désactivé.
    const deletedAt = active === undefined ? u.deleted_at : (active === false ? ts : null);
    db.prepare('UPDATE users SET full_name = COALESCE(?, full_name), role = COALESCE(?, role), password_hash = COALESCE(?, password_hash), deleted_at = ?, updated_at = ? WHERE id = ?')
      .run(fullName !== undefined ? String(fullName).trim() : null,
        role !== undefined ? role : null,
        password !== undefined ? bcrypt.hashSync(String(password), 12) : null,
        deletedAt, ts, u.id);
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
    res.json({ ok: true, user: publicUser(updated) });
  }

  r.patch('/:id', adminOrSelfPatch);
  r.put('/:id', adminOrSelfPatch); // alias (compat `PUT /api/users/:id`)

  return r;
};
