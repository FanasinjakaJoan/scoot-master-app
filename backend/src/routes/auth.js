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
   * Vérifie un jeton sans jamais renvoyer 401 — toujours 200.
   * Utilisé au chargement de l'app pour valider une session restaurée du
   * stockage sans provoquer « Failed to load resource: 401 » dans la console
   * du navigateur. Un jeton invalide/révoqué/expiré hors grâce renvoie
   * `{ valid: false, ... }` (pas de 401), ce qui permet au client de se
   * déconnecter silencieusement sans log d'erreur réseau.
   */
  function verifyTokenForCheck(rawToken) {
    if (!rawToken) {
      return { valid: false, error: 'Authentification requise.', reason: 'missing' };
    }
    let payload;
    try {
      payload = jwt.verify(rawToken, config.jwtSecret);
    } catch (e) {
      if (!e || e.name !== 'TokenExpiredError') {
        return { valid: false, error: 'Jeton invalide.', reason: 'invalid' };
      }
      try {
        payload = jwt.verify(rawToken, config.jwtSecret, { ignoreExpiration: true });
      } catch {
        return { valid: false, error: 'Jeton invalide.', reason: 'invalid' };
      }
      const expiredSince = Math.floor(Date.now() / 1000) - Number(payload.exp || 0);
      if (expiredSince > config.jwtRefreshGraceSeconds) {
        return { valid: false, error: 'Session expirée depuis trop longtemps — reconnectez-vous.', reason: 'expired', expired: true };
      }
    }
    const row = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(payload.sub);
    if (!row) {
      return { valid: false, error: 'Compte supprimé ou désactivé — reconnexion requise.', reason: 'revoked', revoked: true };
    }
    return { valid: true, payload, userRow: row };
  }

  /**
   * POST /api/auth/check — validation de session SANS 401.
   * Toujours 200 : `{ valid: true, token, user, expiresAt }` ou
   * `{ valid: false, error, revoked?, expired?, reason }`.
   * Le client l'appelle au chargement pour vérifier une session restaurée
   * sans déclencher d'erreur réseau visible dans la console.
   */
  r.post('/check', (req, res) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : (req.body && req.body.token) || null;
    const result = verifyTokenForCheck(token);
    if (!result.valid) {
      return res.json({ valid: false, error: result.error, revoked: result.revoked || false, expired: result.expired || false, reason: result.reason });
    }
    res.json({ valid: true, ...sessionPayload(result.userRow) });
  });

  // Alias GET pour compatibilité éventuelle (même sémantique, 200 toujours).
  r.get('/check', (req, res) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const result = verifyTokenForCheck(token);
    if (!result.valid) {
      return res.json({ valid: false, error: result.error, revoked: result.revoked || false, expired: result.expired || false, reason: result.reason });
    }
    res.json({ valid: true, ...sessionPayload(result.userRow) });
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
   *
   * NOTE : pour le chargement initial de l'app, préférer POST /api/auth/check
   * qui ne renvoie jamais 401 et évite le log « Failed to load resource: 401 »
   * dans la console navigateur.
   */
  r.post('/refresh', requireAuthAllowExpired, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(req.user.id);
    if (!u) return res.status(401).json({ error: 'Compte introuvable ou désactivé — reconnexion requise.', revoked: true });
    res.json(sessionPayload(u));
  });

  /**
   * POST /api/auth/refresh-safe — même logique que /refresh mais TOUJOURS 200.
   * Variante sans 401 pour les renouvellements en arrière-plan (keep-alive,
   * retour au premier plan) : évite le bruit console tout en gardant la
   * compatibilité de /refresh (qui reste 401 pour les clients existants).
   * Réponse : `{ valid: true, token, user, ... }` ou `{ valid: false, ... }`.
   */
  r.post('/refresh-safe', (req, res) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const result = verifyTokenForCheck(token);
    if (!result.valid) {
      return res.json({ valid: false, error: result.error, revoked: result.revoked || false, expired: result.expired || false, reason: result.reason });
    }
    res.json({ valid: true, ...sessionPayload(result.userRow) });
  });

  /**
   * POST /api/auth/confirm-password — confirmation par mot de passe pour
   * les actions sensibles (téléversement, gestion utilisateurs, etc.).
   *
   * Le client envoie son mot de passe courant ; si valide, le serveur
   * délivre un nouveau jeton frais (session renouvelée). Cela permet :
   * - de débloquer une session expirée sans ressaisir l'identifiant ;
   * - d'autoriser explicitement une action sensible après re-saisie du
   *   mot de passe (principe « sudo »).
   *
   * Accepte un jeton expiré dans la grâce (requireAuthAllowExpired) pour
   * permettre la reconnexion par mot de passe même après expiration.
   *
   * Body: { password: string }
   * Réponses:
   * - 200 { valid: true, token, expiresAt, user }
   * - 400 si mot de passe manquant
   * - 401 si mot de passe incorrect ou compte révoqué
   */
  r.post('/confirm-password', requireAuthAllowExpired, (req, res) => {
    const { password } = req.body || {};
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Mot de passe requis.' });
    }
    const row = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(req.user.id);
    if (!row) {
      return res.status(401).json({ error: 'Compte supprimé ou désactivé — reconnexion requise.', revoked: true });
    }
    if (!bcrypt.compareSync(String(password), row.password_hash)) {
      return res.status(401).json({ error: 'Mot de passe incorrect.' });
    }
    res.json({ valid: true, ...sessionPayload(row) });
  });

  /**
   * POST /api/auth/verify-password — variante légère qui ne délivre PAS de
   * nouveau jeton, seulement { valid: true } si le mot de passe est correct.
   * Utile pour une simple vérification sans renouveler la session.
   */
  r.post('/verify-password', requireAuthAllowExpired, (req, res) => {
    const { password } = req.body || {};
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Mot de passe requis.' });
    }
    const row = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(req.user.id);
    if (!row) {
      return res.status(401).json({ error: 'Compte supprimé ou désactivé.', revoked: true });
    }
    if (!bcrypt.compareSync(String(password), row.password_hash)) {
      return res.status(401).json({ error: 'Mot de passe incorrect.', valid: false });
    }
    res.json({ valid: true });
  });

  return r;
};
