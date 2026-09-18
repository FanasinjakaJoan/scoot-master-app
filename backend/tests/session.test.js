'use strict';

/**
 * Durée de session — la session doit rester ouverte jusqu'à la déconnexion
 * explicite de l'utilisateur.
 *
 * Couvre les correctifs de « déconnexion automatique peu après la connexion » :
 *  - le jeton délivré au login a une durée de vie longue (30 jours par défaut) ;
 *  - la réponse expose l'échéance absolue (`expiresAt`), pour que le client ne
 *    dépende pas de l'horloge — souvent décalée — de l'appareil ;
 *  - `POST /api/auth/refresh` accepte un jeton RÉCEMMENT EXPIRÉ (fenêtre de
 *    tolérance) : un appareil resté hors ligne retrouve sa session ;
 *  - un jeton expiré hors tolérance, mal signé, ou d'un compte désactivé est
 *    refusé (401) — la révocation reste effective ;
 *  - une route protégée renvoie `expired: true` sur jeton expiré, pour que le
 *    client tente un renouvellement au lieu de déconnecter.
 */

const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const { startTestServer, login, api } = require('./helpers');
const { config, ttlToSeconds } = require('../src/config');

/** Forge un jeton signé avec le secret du serveur, expiré depuis `agoSec`. */
function expiredToken(user, agoSec) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role, fullName: user.fullName, iat: now - agoSec - 60, exp: now - agoSec },
    config.jwtSecret
  );
}

test('session : durée longue, renouvellement tolérant, révocation effective', async (t) => {
  const srv = await startTestServer();
  try {
    await t.test('ttlToSeconds convertit les durées lisibles', () => {
      assert.equal(ttlToSeconds('30d', 0), 30 * 86400);
      assert.equal(ttlToSeconds('12h', 0), 12 * 3600);
      assert.equal(ttlToSeconds('45m', 0), 45 * 60);
      assert.equal(ttlToSeconds('90s', 0), 90);
      assert.equal(ttlToSeconds('3600', 0), 3600);
      assert.equal(ttlToSeconds('n importe quoi', 42), 42, 'valeur illisible → repli');
    });

    await t.test('le login délivre une session longue avec échéance absolue', async () => {
      const { status, token, expiresAt, expiresIn } = await login(srv.base);
      assert.equal(status, 200);
      const payload = jwt.decode(token);
      const lifetime = payload.exp - payload.iat;
      assert.ok(lifetime >= 7 * 86400, `la session doit durer au moins 7 jours (obtenu ${lifetime}s)`);
      assert.equal(expiresIn, config.jwtTtlSeconds);
      assert.ok(expiresAt > Date.now(), 'expiresAt est dans le futur');
    });

    await t.test('un jeton expiré sur une route protégée est signalé comme renouvelable', async () => {
      const me = await login(srv.base);
      const stale = expiredToken({ id: me.user.id, username: me.user.username, role: me.user.role, fullName: me.user.fullName }, 60);
      const res = await api(srv.base, stale, 'GET', '/api/bikes');
      assert.equal(res.status, 401);
      assert.equal(res.body.expired, true, 'le client doit pouvoir distinguer « à renouveler » de « invalide »');
    });

    await t.test('refresh : un jeton récemment expiré rouvre la session', async () => {
      const me = await login(srv.base);
      // Appareil resté hors ligne 2 jours : le jeton est expiré, mais dans la
      // fenêtre de tolérance — l'utilisateur ne doit PAS être déconnecté.
      const stale = expiredToken({ id: me.user.id, username: me.user.username, role: me.user.role, fullName: me.user.fullName }, 2 * 86400);
      const res = await api(srv.base, stale, 'POST', '/api/auth/refresh');
      assert.equal(res.status, 200, 'le renouvellement doit être accepté');
      assert.ok(res.body.token);
      assert.equal(res.body.user.username, 'admin');

      // Le jeton renouvelé ouvre bien les routes protégées.
      const protectedRes = await api(srv.base, res.body.token, 'GET', '/api/bikes');
      assert.equal(protectedRes.status, 200);
    });

    await t.test('refresh : au-delà de la tolérance, reconnexion exigée', async () => {
      const me = await login(srv.base);
      const ancient = expiredToken(
        { id: me.user.id, username: me.user.username, role: me.user.role, fullName: me.user.fullName },
        config.jwtRefreshGraceSeconds + 86400
      );
      const res = await api(srv.base, ancient, 'POST', '/api/auth/refresh');
      assert.equal(res.status, 401);
      assert.match(res.body.error, /reconnectez-vous/i);
    });

    await t.test('refresh : un jeton mal signé est toujours refusé', async () => {
      const forged = jwt.sign(
        { sub: 'u-pirate', username: 'pirate', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 },
        'mauvais-secret'
      );
      const res = await api(srv.base, forged, 'POST', '/api/auth/refresh');
      assert.equal(res.status, 401);
    });

    await t.test('refresh : compte supprimé → session close immédiatement', async () => {
      const admin = await login(srv.base);
      const created = await api(srv.base, admin.token, 'POST', '/api/users', {
        username: 'temporaire', fullName: 'Compte Temporaire', password: 'motdepasse1', role: 'seller',
      });
      assert.equal(created.status, 201);
      const victim = await login(srv.base, 'temporaire', 'motdepasse1');
      assert.equal(victim.status, 200);

      // Suppression logique du compte en base (révocation).
      srv.db.prepare('UPDATE users SET deleted_at = ? WHERE id = ?')
        .run(new Date().toISOString(), created.body.user.id);

      const res = await api(srv.base, victim.token, 'POST', '/api/auth/refresh');
      assert.equal(res.status, 401, 'un compte supprimé ne peut plus renouveler sa session');
    });
  } finally {
    await srv.close();
  }
});
