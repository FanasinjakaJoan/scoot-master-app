'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startTestServer, login, api } = require('./helpers');

test('auth : login, me, contrôle des rôles', async (t) => {
  const srv = await startTestServer();
  try {
    await t.test('login valide délivre un JWT', async () => {
      const { status, token, user } = await login(srv.base);
      assert.equal(status, 200);
      assert.ok(token);
      assert.equal(user.role, 'admin');
    });

    await t.test('login invalide renvoie 401', async () => {
      const { status } = await login(srv.base, 'admin', 'mauvais');
      assert.equal(status, 401);
    });

    await t.test('route protégée sans jeton → 401', async () => {
      const { status } = await api(srv.base, null, 'GET', '/api/bikes');
      assert.equal(status, 401);
    });

    await t.test('jeton invalide → 401', async () => {
      const { status } = await api(srv.base, 'abc.def.ghi', 'GET', '/api/bikes');
      assert.equal(status, 401);
    });

    await t.test('GET /api/auth/me renvoie le profil', async () => {
      const { token } = await login(srv.base);
      const { status, body } = await api(srv.base, token, 'GET', '/api/auth/me');
      assert.equal(status, 200);
      assert.equal(body.user.role, 'admin');
    });

    await t.test('suppression d\u2019une moto : vendeur refusé, admin accepté', async () => {
      const admin = await login(srv.base);
      const seller = await login(srv.base, 'vendeur', 'vendeur123');

      const created = await api(srv.base, admin.token, 'POST', '/api/bikes', {
        brand: 'Yamaha', model: 'Test 125', price: 1000000,
      });
      assert.equal(created.status, 201);
      const id = created.body.bike.id;

      const denied = await api(srv.base, seller.token, 'DELETE', `/api/bikes/${id}`);
      assert.equal(denied.status, 403);

      const ok = await api(srv.base, admin.token, 'DELETE', `/api/bikes/${id}`);
      assert.equal(ok.status, 200);

      const gone = await api(srv.base, admin.token, 'GET', `/api/bikes/${id}`);
      assert.equal(gone.status, 404);
    });
  } finally {
    await srv.close();
  }
});
