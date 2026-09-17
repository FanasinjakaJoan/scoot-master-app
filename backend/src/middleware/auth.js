'use strict';

const jwt = require('jsonwebtoken');
const { config } = require('../config');

/** Exige un jeton Bearer valide ; attache `req.user = {id, username, role, fullName}`. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentification requise.' });
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.user = {
      id: payload.sub,
      username: payload.username,
      role: payload.role,
      fullName: payload.fullName,
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Jeton invalide ou expiré.' });
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

module.exports = { requireAuth, requireRole };
