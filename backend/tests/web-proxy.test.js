'use strict';

/**
 * Tests du reverse-proxy web (`deploy/web-server.js`).
 *
 * Régression couverte : l'apex `https://` de l'hébergeur répond `301` en clair
 * sur le port 80. Le proxy connectait l'amont sur `port || 80` quel que soit le
 * protocole ; les redirections étaient ensuite renvoyées au navigateur, qui les
 * suivait en **retirant `Authorization`** (spécification Fetch) : `/api/*`
 * rejouait sans jeton → 401/403 → synchronisation rompue.
 *
 * Les tests démarrent un amont réel qui redirige vers un backend réel, afin
 * d'exercer la vraie mécanique de sockets, pas un simulacre.
 */

const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const { transportFor, normalizeApiTarget } = require('../../deploy/web-server.js');

/** Démarre un serveur HTTP sur un port libre et renvoie `{ server, url, port }`. */
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/** Envoie une requête au proxy en conservant méthode et en-têtes. */
function request(port, method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      );
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('transportFor : une cible https sans port explicite utilise 443', () => {
  const { agent, port } = transportFor(new URL('https://api.example.com'));
  assert.equal(port, 443, 'ne doit jamais retomber sur 80');
  assert.equal(agent, require('https'));
});

test('transportFor : une cible http sans port explicite utilise 80', () => {
  const { agent, port } = transportFor(new URL('http://api.example.com'));
  assert.equal(port, 80);
  assert.equal(agent, require('http'));
});

test('transportFor : un port explicite est toujours respecté', () => {
  assert.equal(transportFor(new URL('http://api:10000')).port, 10000);
  assert.equal(transportFor(new URL('https://api:8443')).port, 8443);
});

test('normalizeApiTarget : hostport Render sans schéma devient http://', () => {
  assert.equal(normalizeApiTarget('scoot-master-api:10000'), 'http://scoot-master-api:10000');
  assert.equal(normalizeApiTarget('https://api.example.com'), 'https://api.example.com');
  assert.equal(normalizeApiTarget(''), 'http://127.0.0.1:4000');
});

/**
 * Le proxy suit la redirection `301` de l'amont côté serveur : le client reçoit
 * la réponse finale (200 + corps du backend), jamais le 301, et `Authorization`
 * est conservé sur le second saut.
 */
test('proxy : suit un 301 amont et conserve Authorization et le corps', async () => {
  const received = [];
  const backend = await listen((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  // Amont qui imite l'apex : tout est redirigé en 301 vers le backend.
  const apex = await listen((req, res) => {
    res.writeHead(301, { Location: `${backend.url}${req.url}` });
    res.end();
  });

  process.env.API_TARGET = apex.url;
  delete require.cache[require.resolve('../../deploy/web-server.js')];
  const proxy = require('../../deploy/web-server.js');
  const proxyServer = proxy.server;

  try {
    await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
    const proxyPort = proxyServer.address().port;

    const push = await request(
      proxyPort,
      'POST',
      '/api/sync/push',
      { 'Content-Type': 'application/json', Authorization: 'Bearer jeton-test' },
      JSON.stringify({ deviceId: 'd1', operations: [] })
    );

    assert.equal(push.status, 200, 'le client doit recevoir la réponse finale, pas le 301');
    assert.equal(JSON.parse(push.body).ok, true);

    assert.equal(received.length, 1, 'le backend doit être appelé une seule fois');
    assert.equal(received[0].method, 'POST', 'la méthode POST ne doit pas devenir GET');
    assert.equal(received[0].url, '/api/sync/push');
    assert.equal(received[0].auth, 'Bearer jeton-test', 'Authorization ne doit pas être perdu');
    assert.equal(received[0].body, JSON.stringify({ deviceId: 'd1', operations: [] }));
  } finally {
    await close(proxyServer);
    await close(apex.server);
    await close(backend.server);
    delete process.env.API_TARGET;
  }
});

/** Au-delà de la borne, aucune boucle infinie : le 301 est rendu tel quel. */
test('proxy : ne boucle pas sur une chaîne de redirections sans fin', async () => {
  const loop = await listen((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${loop.port}${req.url}` });
    res.end();
  });

  process.env.API_TARGET = loop.url;
  delete require.cache[require.resolve('../../deploy/web-server.js')];
  const proxy = require('../../deploy/web-server.js');

  try {
    await new Promise((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
    const proxyPort = proxy.server.address().port;
    const res = await request(proxyPort, 'GET', '/api/health', {}, undefined);
    assert.ok([301, 302].includes(res.status), `statut final non-redirige attendu, reçu ${res.status}`);
  } finally {
    await close(proxy.server);
    await close(loop.server);
    delete process.env.API_TARGET;
  }
});

test('proxy : rend un 502 JSON quand le backend est injoignable', async () => {
  process.env.API_TARGET = 'http://127.0.0.1:1';
  delete require.cache[require.resolve('../../deploy/web-server.js')];
  const proxy = require('../../deploy/web-server.js');

  try {
    await new Promise((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
    const proxyPort = proxy.server.address().port;
    const res = await request(proxyPort, 'GET', '/api/health', {}, undefined);
    assert.equal(res.status, 502);
    assert.match(res.body, /Backend indisponible/);
  } finally {
    await close(proxy.server);
    delete process.env.API_TARGET;
  }
});

function close(server) {
  if (!server) return Promise.resolve();
  // Node ≥ 19 garde les connexions en vie (`globalAgent.keepAlive = true`) :
  // sans fermeture forcée, une socket inactive maintiendrait `close()` en attente.
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}
