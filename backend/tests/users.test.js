'use strict';

/**
 * Tests d'authentification & gestion des utilisateurs — correctifs 401/403 :
 *  - RBAC liste utilisateurs (admin OK, vendeur 403)
 *  - auto-service du profil (PATCH /api/users/profile) pour tout utilisateur authentifié
 *  - refus d'escalade de privilèges (rôle / statut par un non-admin)
 *  - une édition sans `active` ne réactive PAS un compte désactivé
 *  - renouvellement de jeton (POST /api/auth/refresh)
 *  - téléversement de sauvegarde : 401 sans jeton, 201 avec jeton
 */

const test = require('node:test');
const assert = require('node:assert');
const { startTestServer, login, api } = require('./helpers');

test('utilisateurs : RBAC, profil, refresh, sauvegarde', async (t) => {
  const srv = await startTestServer();
  try {
    await t.test('GET /api/users : admin autorisé, vendeur 403, anonyme 401', async () => {
      const anon = await api(srv.base, null, 'GET', '/api/users');
      assert.equal(anon.status, 401);
      assert.ok(anon.body.error);

      const seller = await login(srv.base, 'vendeur', 'vendeur123');
      const denied = await api(srv.base, seller.token, 'GET', '/api/users');
      assert.equal(denied.status, 403);
      assert.ok(denied.body.error);

      const admin = await login(srv.base);
      const ok = await api(srv.base, admin.token, 'GET', '/api/users');
      assert.equal(ok.status, 200);
      assert.ok(Array.isArray(ok.body.users) && ok.body.users.length >= 2);
      assert.ok(ok.body.users.every((u) => !('password_hash' in u)));
    });

    await t.test('PATCH /api/users/profile : tout utilisateur authentifié modifie SON profil', async () => {
      const seller = await login(srv.base, 'vendeur', 'vendeur123');
      const res = await api(srv.base, seller.token, 'PATCH', '/api/users/profile', {
        fullName: 'Hery A. (mis à jour)',
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.fullName, 'Hery A. (mis à jour)');
      assert.equal(res.body.user.role, 'seller');

      // /api/auth/me reflète le JWT initial (fullName du jeton) ; en base c'est à jour :
      const row = srv.db.prepare('SELECT full_name FROM users WHERE username = ?').get('vendeur');
      assert.equal(row.full_name, 'Hery A. (mis à jour)');

      // Changement de mot de passe par la même voie (puis remise en état pour les sous-tests suivants)
      const res2 = await api(srv.base, seller.token, 'PATCH', '/api/users/profile', { password: 'nouveau123' });
      assert.equal(res2.status, 200);
      const relog = await login(srv.base, 'vendeur', 'nouveau123');
      assert.equal(relog.status, 200);
      await api(srv.base, seller.token, 'PATCH', '/api/users/profile', { password: 'vendeur123' });
      assert.equal((await login(srv.base, 'vendeur', 'vendeur123')).status, 200);
    });

    await t.test('aucune escalade de privilèges : un vendeur ne peut pas devenir admin ni (dés)activer', async () => {
      const seller = await login(srv.base, 'vendeur', 'vendeur123');

      const self = await api(srv.base, seller.token, 'PATCH', `/api/users/${seller.user.id}`, { role: 'admin' });
      assert.equal(self.status, 403);
      const row = srv.db.prepare('SELECT role FROM users WHERE id = ?').get(seller.user.id);
      assert.equal(row.role, 'seller');

      const selfActive = await api(srv.base, seller.token, 'PATCH', `/api/users/${seller.user.id}`, { active: false });
      assert.equal(selfActive.status, 403);

      const other = await api(srv.base, seller.token, 'PATCH', `/api/users/${(await login(srv.base)).user.id}`, { fullName: 'Piraté' });
      assert.equal(other.status, 403);
    });

    await t.test('admin : édition des rôles/informations OK, garde-fous sur soi-même', async () => {
      const admin = await login(srv.base);
      const seller = await login(srv.base, 'vendeur', 'vendeur123');

      const promo = await api(srv.base, admin.token, 'PUT', `/api/users/${seller.user.id}`, { role: 'admin' });
      assert.equal(promo.status, 200);
      assert.equal(promo.body.user.role, 'admin');
      // retour à l'état initial
      await api(srv.base, admin.token, 'PATCH', `/api/users/${seller.user.id}`, { role: 'seller' });

      const selfRole = await api(srv.base, admin.token, 'PATCH', `/api/users/${admin.user.id}`, { role: 'seller' });
      assert.equal(selfRole.status, 400);
      const selfOff = await api(srv.base, admin.token, 'PATCH', `/api/users/${admin.user.id}`, { active: false });
      assert.equal(selfOff.status, 400);
    });

    await t.test('une édition sans `active` ne réactive PAS un compte désactivé', async () => {
      const admin = await login(srv.base);
      const created = await api(srv.base, admin.token, 'POST', '/api/users', {
        username: 'temporaire', password: 'motdepasse1', fullName: 'Compte Temporaire', role: 'seller',
      });
      assert.equal(created.status, 201);
      const uid = created.body.user.id;

      const off = await api(srv.base, admin.token, 'PATCH', `/api/users/${uid}`, { active: false });
      assert.equal(off.status, 200);
      assert.equal(off.body.user.active, false);

      // édition d'information SANS toucher à `active`
      const rename = await api(srv.base, admin.token, 'PATCH', `/api/users/${uid}`, { fullName: 'Tempo Renommé' });
      assert.equal(rename.status, 200);
      assert.equal(rename.body.user.active, false, 'le compte doit rester désactivé');

      const reon = await api(srv.base, admin.token, 'PATCH', `/api/users/${uid}`, { active: true });
      assert.equal(reon.status, 200);
      assert.equal(reon.body.user.active, true);
    });

    await t.test('POST /api/auth/refresh : renouvelle un jeton valide, refuse un jeton invalide', async () => {
      const seller = await login(srv.base, 'vendeur', 'vendeur123');
      const ok = await api(srv.base, seller.token, 'POST', '/api/auth/refresh');
      assert.equal(ok.status, 200);
      assert.ok(ok.body.token, 'un jeton renouvelé est renvoyé');
      assert.equal(ok.body.user.username, 'vendeur');
      // le nouveau jeton fonctionne
      const me = await api(srv.base, ok.body.token, 'GET', '/api/auth/me');
      assert.equal(me.status, 200);

      const bad = await api(srv.base, 'jeton.invalide.abc', 'POST', '/api/auth/refresh');
      assert.equal(bad.status, 401);
      assert.ok(bad.body.error);
    });

    await t.test('téléversement de sauvegarde : 401 sans jeton, 201 avec jeton valide', async () => {
      const denied = await api(srv.base, null, 'POST', '/api/exports/backup', { fileName: 'test.json', data: { bikes: [] } });
      assert.equal(denied.status, 401);
      assert.equal(denied.body.error, 'Authentification requise.');

      const admin = await login(srv.base);
      const ok = await api(srv.base, admin.token, 'POST', '/api/exports/backup', {
        fileName: 'test.json',
        data: { app: 'scoot-master', version: 1, bikes: [], customers: [], sales: [] },
      });
      assert.equal(ok.status, 201);
      assert.equal(ok.body.ok, true);

      // PUSH / PULL : 401 JSON clair sans jeton
      const pushNoAuth = await api(srv.base, null, 'POST', '/api/sync/push', { deviceId: 'd1', operations: [] });
      assert.equal(pushNoAuth.status, 401);
      const pullNoAuth = await api(srv.base, null, 'GET', '/api/sync/pull?since=1970-01-01T00:00:00.000Z');
      assert.equal(pullNoAuth.status, 401);
      assert.ok(pullNoAuth.body.error);
    });
  } finally {
    await srv.close();
  }
});
