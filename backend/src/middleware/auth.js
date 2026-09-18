'use strict';

const jwt = require('jsonwebtoken');
const { config } = require('../config');

/** Extrait le jeton Bearer de l'en-tête Authorization (ou null). */
function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/** Projette le payload JWT vers `req.user`. */
function toUser(payload) {
  return {
    id: payload.sub,
    username: payload.username,
    role: payload.role,
    fullName: payload.fullName,
  };
}

/** Réponse 401 normalisée pour un compte révoqué (supprimé ou désactivé). */
const REVOKED_RESPONSE = {
  error: 'Compte supprimé ou désactivé — reconnexion requise.',
  // `revoked: true` distingue une fin de session DÉFINITIVE (le compte n'existe
  // plus) d'un simple jeton à renouveler (`expired: true`) : le client demande
  // alors une réauthentification au lieu de tenter un /api/auth/refresh.
  revoked: true,
};

/**
 * Contrôle de révocation : le compte désigné par le jeton existe-t-il toujours
 * et reste-t-il actif ?
 *
 * Sans ce contrôle, un jeton correctement signé restait accepté par TOUTES les
 * routes protégées après la suppression ou la désactivation du compte (seul
 * `POST /api/auth/refresh` revérifiait la base) : la révocation n'était donc
 * effective qu'au prochain renouvellement, et un jeton forgé avec un `role`
 * arbitraire obtenait les droits correspondants.
 *
 * Le profil renvoyé est relu EN BASE (rôle et nom inclus) : le contenu du jeton
 * ne fait plus autorité. Renvoie `null` si le compte est introuvable/inactif.
 * La base est portée par `app.locals.db` (voir `createApp`), ce qui évite de
 * modifier chaque route ; sans base attachée, on retombe sur le payload.
 */
function loadActiveUser(req, payload) {
  const db = req.app && req.app.locals ? req.app.locals.db : null;
  if (!db) return toUser(payload);
  const row = db
    .prepare('SELECT id, username, role, full_name, deleted_at FROM users WHERE id = ?')
    .get(payload.sub);
  if (!row || row.deleted_at) return null;
  return { id: row.id, username: row.username, role: row.role, fullName: row.full_name };
}

/** Exige un jeton Bearer valide ; attache `req.user = {id, username, role, fullName}`. */
function requireAuth(req, res, next) {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'Authentification requise.' });
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch (e) {
    // `expired: true` permet au client de distinguer une session à renouveler
    // (POST /api/auth/refresh) d'un jeton réellement invalide (secret changé…).
    if (e && e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expirée — renouvellement requis.', expired: true });
    }
    return res.status(401).json({ error: 'Jeton invalide ou expiré.' });
  }
  const user = loadActiveUser(req, payload);
  if (!user) return res.status(401).json(REVOKED_RESPONSE);
  req.user = user;
  next();
}

/**
 * Variante réservée au renouvellement de session (`POST /api/auth/refresh`).
 *
 * Accepte un jeton correctement signé **même s'il vient d'expirer**, dans la
 * limite de `JWT_REFRESH_GRACE` (défaut 60 jours) après son expiration. La
 * signature reste vérifiée : un jeton forgé ou signé avec un autre secret est
 * toujours rejeté. Objectif : un appareil resté hors ligne ou en veille
 * retrouve sa session au retour du réseau, au lieu d'être déconnecté.
 */
function requireAuthAllowExpired(req, res, next) {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'Authentification requise.' });
  let payload = null;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch (e) {
    if (!e || e.name !== 'TokenExpiredError') {
      return res.status(401).json({ error: 'Jeton invalide.' });
    }
    // Jeton expiré : on re-vérifie la signature en ignorant `exp`, puis on
    // applique la fenêtre de tolérance.
    try {
      payload = jwt.verify(token, config.jwtSecret, { ignoreExpiration: true });
    } catch {
      return res.status(401).json({ error: 'Jeton invalide.' });
    }
    const expiredSince = Math.floor(Date.now() / 1000) - Number(payload.exp || 0);
    if (expiredSince > config.jwtRefreshGraceSeconds) {
      return res.status(401).json({
        error: 'Session expirée depuis trop longtemps — reconnectez-vous.',
        expired: true,
      });
    }
  }
  const user = loadActiveUser(req, payload);
  if (!user) return res.status(401).json(REVOKED_RESPONSE);
  req.user = user;
  next();
}

/** Exige un rôle précis (usage courant : 'admin'). */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentification requise.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Droits insuffisants (rôle requis : ' + roles.join(' ou ') + ').' });
    }
    next();
  };
}

module.exports = { requireAuth, requireAuthAllowExpired, requireRole };
