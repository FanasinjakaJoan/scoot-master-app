'use strict';

/**
 * Régressions CORS : la synchronisation de l'app web passait pour une erreur
 * « 403 » parce que l'API ne renvoyait aucun `Access-Control-Allow-Origin` aux
 * requêtes cross-origin (l'app web déployée est redirigée par l'edge de
 * l'hébergeur vers le domaine de l'API). Ces tests verrouillent le fait qu'un
 * navigateur reçoit TOUJOURS l'en-tête, y compris en pré-vol et sur les routes
 * de synchronisation.
 */

const test = require('node:test');
const assert = require('node:assert');
const { startTestServer, login } = require('./helpers');
const { parseCorsOrigins } = require('../src/config');

const WEB_ORIGIN = 'https://scoot-master-web.onrender.com';

test('CORS : la synchronisation reste joignable cross-origin', async (t) => {
  const srv = await startTestServer();
  const { token } = await login(srv.base);

  await t.test('pré-vol accepté sur /api/sync/push', async () => {
    const res = await fetch(srv.base + '/api/sync/push', {
      method: 'OPTIONS',
      headers: {
        Origin: WEB_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), WEB_ORIGIN);
    assert.match(res.headers.get('access-control-allow-headers') || '', /authorization/i);
    assert.match(res.headers.get('access-control-allow-methods') || '', /POST/);
    assert.match(res.headers.get('vary') || '', /Origin/);
  });

  await t.test('push cross-origin : en-tête CORS + 200', async () => {
    const id = 'cors-test-bike';
    const res = await fetch(srv.base + '/api/sync/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
        Origin: WEB_ORIGIN,
      },
      body: JSON.stringify({
        deviceId: 'dev-cors',
        operations: [
          {
            entity: 'bikes',
            op: 'create',
            id,
            payload: { id, brand: 'Honda', model: 'CG 125', price: 1200000, status: 'available' },
            clientTs: new Date().toISOString(),
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), WEB_ORIGIN);
    assert.equal((await res.json()).stats.ok, 1);
  });

  await t.test('pull et statut cross-origin : en-tête CORS présent', async () => {
    for (const path of ['/api/sync/pull?since=1970-01-01T00:00:00.000Z', '/api/sync/status']) {
      const res = await fetch(srv.base + path, {
        headers: { Authorization: 'Bearer ' + token, Origin: WEB_ORIGIN },
      });
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('access-control-allow-origin'), WEB_ORIGIN, path);
    }
  });

  await t.test('connexion cross-origin : en-tête CORS sur la réponse', async () => {
    const res = await fetch(srv.base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: WEB_ORIGIN },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), WEB_ORIGIN);
  });

  await t.test('une origine inconnue est quand même servie (auth par en-tête)', async () => {
    const res = await fetch(srv.base + '/api/health', { headers: { Origin: 'https://exemple.inconnu' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://exemple.inconnu');
  });

  await t.test('requête sans Origin (sonde de santé) : ACAO *', async () => {
    const res = await fetch(srv.base + '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  await srv.close();
});

test('CORS : normalisation de CORS_ORIGIN', async (t) => {
  await t.test('vide, * ou false ⇒ toutes les origines', () => {
    for (const value of ['', '   ', '*', 'false', undefined, null]) {
      assert.equal(parseCorsOrigins(value), '*', String(value));
    }
  });

  await t.test('liste tolérante (espaces, slash final, hôte nu)', () => {
    assert.deepEqual(parseCorsOrigins('https://a.example, https://b.example/'), [
      'https://a.example',
      'https://b.example',
    ]);
    assert.deepEqual(parseCorsOrigins('c.example'), ['https://c.example']);
  });

  await t.test('entrées inexploitables ignorées sans faire échouer le démarrage', () => {
    assert.deepEqual(parseCorsOrigins('https://ok.example, , not a url with spaces'), ['https://ok.example']);
  });

  await t.test('mode strict : origine hors liste refusée', async () => {
    const { createApp } = require('../src/app');
    const { initDb } = require('../src/db/init');
    const db = initDb({ dbPath: ':memory:', seedOnStart: 'users' });
    const app = createApp(db, { corsOrigins: ['https://autorise.example'], corsStrict: true });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const blocked = await fetch(base + '/api/health', { headers: { Origin: WEB_ORIGIN } });
      assert.equal(blocked.status, 200);
      assert.equal(blocked.headers.get('access-control-allow-origin'), null);

      const allowed = await fetch(base + '/api/health', { headers: { Origin: 'https://autorise.example' } });
      assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://autorise.example');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});