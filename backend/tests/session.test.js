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

/** Forge un jeton VALIDE (non expiré) pour un utilisateur, avec surcharges. */
function tokenFor(user, overrides = {}) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role, fullName: user.fullName, ...overrides },
    config.jwtSecret,
    { expiresIn: '1h' }
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

    await t.test('sync : session maintenue pendant la synchronisation (401 renouvelable → refresh → push/pull OK)', async () => {
      const me = await login(srv.base);
      const stale = expiredToken({ id: me.user.id, username: me.user.username, role: me.user.role, fullName: me.user.fullName }, 3600);
      const pushBody = {
        deviceId: 'dev-session-test',
        operations: [{
          entity: 'bikes', op: 'create', id: 'b-session-keep',
          payload: { brand: 'Yamaha', model: 'YBR 125', price: 900000 },
          clientTs: new Date().toISOString(),
        }],
      };

      // 1) Un cycle démarré avec un jeton expiré est rejeté sur push ET pull,
      //    mais signalé comme renouvelable (`expired: true`) : le client doit
      //    tenter un renouvellement transparent, pas déconnecter.
      const denied = await api(srv.base, stale, 'POST', '/api/sync/push', pushBody);
      assert.equal(denied.status, 401);
      assert.equal(denied.body.expired, true);
      const deniedPull = await api(srv.base, stale, 'GET', '/api/sync/pull?since=1970-01-01T00:00:00.000Z');
      assert.equal(deniedPull.status, 401);
      assert.equal(deniedPull.body.expired, true);

      // 2) Le même jeton expiré renouvelle la session…
      const renewed = await api(srv.base, stale, 'POST', '/api/auth/refresh');
      assert.equal(renewed.status, 200, 'le renouvellement doit être accepté');
      assert.ok(renewed.body.token);

      // 3) …et le cycle reprend avec le jeton frais : push appliqué, pull servi.
      const pushed = await api(srv.base, renewed.body.token, 'POST', '/api/sync/push', pushBody);
      assert.equal(pushed.status, 200);
      assert.equal(pushed.body.results[0].status, 'ok');
      const pulled = await api(srv.base, renewed.body.token, 'GET', '/api/sync/pull?since=1970-01-01T00:00:00.000Z');
      assert.equal(pulled.status, 200);
      assert.ok(Array.isArray(pulled.body.changes));
    });

    // ---------------------------------------------------------------------
    // Révocation effective sur TOUTES les routes protégées.
    // Un jeton correctement signé ne suffit plus : le compte est relu en base
    // à chaque requête. Sans ce contrôle, un compte supprimé/désactivé gardait
    // un accès complet jusqu'à son prochain renouvellement de session.
    // ---------------------------------------------------------------------
    await t.test('révocation : compte supprimé → 401 sur les routes protégées', async () => {
      const admin = await login(srv.base);
      const created = await api(srv.base, admin.token, 'POST', '/api/users', {
        username: 'supprime', fullName: 'Compte Supprimé', password: 'motdepasse1', role: 'seller',
      });
      assert.equal(created.status, 201);
      const victim = await login(srv.base, 'supprime', 'motdepasse1');
      assert.equal(victim.status, 200);

      srv.db.prepare('UPDATE users SET deleted_at = ? WHERE id = ?')
        .run(new Date().toISOString(), created.body.user.id);

      for (const [method, path] of [['GET', '/api/bikes'], ['GET', '/api/customers'], ['GET', '/api/sales']]) {
        const res = await api(srv.base, victim.token, method, path);
        assert.equal(res.status, 401, `${method} ${path} doit refuser un compte supprimé`);
        assert.equal(res.body.revoked, true, 'le client doit pouvoir distinguer « compte révoqué » de « jeton à renouveler »');
      }
      // La synchronisation est concernée au même titre que la lecture.
      const pushed = await api(srv.base, victim.token, 'POST', '/api/sync/push', { deviceId: 'd1', operations: [] });
      assert.equal(pushed.status, 401);
    });

    await t.test('révocation : compte désactivé → 401, réactivation → accès rendu', async () => {
      const admin = await login(srv.base);
      const created = await api(srv.base, admin.token, 'POST', '/api/users', {
        username: 'suspendu', fullName: 'Compte Suspendu', password: 'motdepasse1', role: 'seller',
      });
      const victim = await login(srv.base, 'suspendu', 'motdepasse1');

      const off = await api(srv.base, admin.token, 'PATCH', `/api/users/${created.body.user.id}`, { active: false });
      assert.equal(off.status, 200);
      const denied = await api(srv.base, victim.token, 'GET', '/api/bikes');
      assert.equal(denied.status, 401, 'un compte désactivé perd l’accès immédiatement');
      assert.equal(denied.body.revoked, true);

      const on = await api(srv.base, admin.token, 'PATCH', `/api/users/${created.body.user.id}`, { active: true });
      assert.equal(on.status, 200);
      const allowed = await api(srv.base, victim.token, 'GET', '/api/bikes');
      assert.equal(allowed.status, 200, 'la réactivation rend l’accès sans reconnexion');
    });

    await t.test('le rôle est lu en base : un jeton au rôle falsifié n’obtient pas les droits admin', async () => {
      const seller = await login(srv.base, 'vendeur', 'vendeur123');
      // Jeton signé avec le bon secret mais prétendant au rôle admin.
      const forged = tokenFor(
        { id: seller.user.id, username: seller.user.username, role: 'admin', fullName: seller.user.fullName }
      );
      const listed = await api(srv.base, forged, 'GET', '/api/users');
      assert.equal(listed.status, 403, 'le rôle admin revendiqué dans le jeton ne doit pas être accepté');

      const me = await api(srv.base, forged, 'GET', '/api/auth/me');
      assert.equal(me.status, 200);
      assert.equal(me.body.user.role, 'seller', 'le profil servi provient de la base, pas du jeton');
    });

    await t.test('jeton d’un utilisateur inexistant → 401 (aucun accès anonyme privilégié)', async () => {
      const ghost = tokenFor({ id: 'utilisateur-fantome', username: 'fantome', role: 'admin', fullName: 'Fantôme' });
      const res = await api(srv.base, ghost, 'GET', '/api/users');
      assert.equal(res.status, 401);
      assert.equal(res.body.revoked, true);
    });
  } finally {
    await srv.close();
  }
});
