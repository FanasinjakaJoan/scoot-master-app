'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { config } = require('../config');
const { requireAuth } = require('../middleware/auth');

module.exports = function authRoutes(db) {
  const r = express.Router();

  /** POST /api/auth/login — identifie l'utilisateur et délivre un JWT. */
  r.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Identifiant et mot de passe requis.' });
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL').get(String(username).trim());
    if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
      return res.status(401).json({ error: 'Identifiants incorrects.' });
    }
    const token = jwt.sign(
      { sub: user.id, username: user.username, role: user.role, fullName: user.full_name },
      config.jwtSecret,
      { expiresIn: config.jwtTtl }
    );
    res.json({
      token,
      user: { id: user.id, username: user.username, fullName: user.full_name, role: user.role },
    });
  });

  r.post('/logout', requireAuth, (req, res) => res.status(204).send());

  /** GET /api/auth/me — profil de l'utilisateur courant. */
  r.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  return r;
};
