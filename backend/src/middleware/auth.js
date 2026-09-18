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

/** Exige un jeton Bearer valide ; attache `req.user = {id, username, role, fullName}`. */
function requireAuth(req, res, next) {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'Authentification requise.' });
  try {
    req.user = toUser(jwt.verify(token, config.jwtSecret));
    next();
  } catch (e) {
    // `expired: true` permet au client de distinguer une session à renouveler
    // (POST /api/auth/refresh) d'un jeton réellement invalide (secret changé…).
    if (e && e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expirée — renouvellement requis.', expired: true });
    }
    return res.status(401).json({ error: 'Jeton invalide ou expiré.' });
  }
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
  try {
    req.user = toUser(jwt.verify(token, config.jwtSecret));
    return next();
  } catch (e) {
    if (!e || e.name !== 'TokenExpiredError') {
      return res.status(401).json({ error: 'Jeton invalide.' });
    }
  }
  // Jeton expiré : on re-vérifie la signature en ignorant `exp`, puis on
  // applique la fenêtre de tolérance.
  try {
    const payload = jwt.verify(token, config.jwtSecret, { ignoreExpiration: true });
    const expiredSince = Math.floor(Date.now() / 1000) - Number(payload.exp || 0);
    if (expiredSince > config.jwtRefreshGraceSeconds) {
      return res.status(401).json({
        error: 'Session expirée depuis trop longtemps — reconnectez-vous.',
        expired: true,
      });
    }
    req.user = toUser(payload);
    return next();
  } catch {
    return res.status(401).json({ error: 'Jeton invalide.' });
  }
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
