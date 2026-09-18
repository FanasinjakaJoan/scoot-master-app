'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { config } = require('../config');
const { requireAuth, requireAuthAllowExpired } = require('../middleware/auth');

module.exports = function authRoutes(db) {
  const r = express.Router();

  /** Émet un JWT de session pour un compte (durée : config.jwtTtl). */
  function issueToken(user) {
    return jwt.sign(
      { sub: user.id, username: user.username, role: user.role, fullName: user.full_name },
      config.jwtSecret,
      { expiresIn: config.jwtTtl }
    );
  }

  /** Réponse de session normalisée (jeton + profil + échéance). */
  function sessionPayload(user) {
    const token = issueToken(user);
    return {
      token,
      // Échéance absolue (epoch ms) : l'app sait quand renouveler sans décoder
      // le jeton, et reste insensible à un décalage d'horloge de l'appareil.
      expiresAt: Date.now() + config.jwtTtlSeconds * 1000,
      expiresIn: config.jwtTtlSeconds,
      user: { id: user.id, username: user.username, fullName: user.full_name, role: user.role },
    };
  }

  /** POST /api/auth/login — identifie l'utilisateur et délivre un JWT. */
  r.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Identifiant et mot de passe requis.' });
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL').get(String(username).trim());
    if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
      return res.status(401).json({ error: 'Identifiants incorrects.' });
    }
    res.json(sessionPayload(user));
  });

  r.post('/logout', requireAuth, (req, res) => res.status(204).send());

  /** GET /api/auth/me — profil de l'utilisateur courant. */
  r.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  /**
   * POST /api/auth/refresh — renouvelle le jeton (glissement de session).
   *
   * La session reste ouverte tant que l'utilisateur ne se déconnecte pas
   * lui-même : ce point d'entrée accepte le jeton courant **ainsi qu'un jeton
   * récemment expiré** (signature valide, dans la fenêtre `JWT_REFRESH_GRACE`,
   * 60 jours par défaut) — un appareil resté hors ligne ou en veille retrouve
   * donc sa session au retour du réseau au lieu d'être déconnecté.
   *
   * Le compte est re-vérifié en base à chaque renouvellement : suppression ou
   * désactivation ⇒ 401 immédiat (révocation effective).
   */
  r.post('/refresh', requireAuthAllowExpired, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(req.user.id);
    if (!u) return res.status(401).json({ error: 'Compte introuvable ou désactivé — reconnexion requise.' });
    res.json(sessionPayload(u));
  });

  return r;
};
