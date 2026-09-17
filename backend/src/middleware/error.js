'use strict';

/** Gestionnaire d'erreurs centralisé. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON invalide.' });
  }
  const status = err.status || 500;
  const body = { error: err.message || 'Erreur serveur.' };
  if (status >= 500) console.error('[erreur]', err);
  res.status(status).json(body);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { errorHandler, HttpError };
