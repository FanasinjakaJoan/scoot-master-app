'use strict';

/**
 * Sauvegarde automatisée vers Google Drive (compte de service) & export complet.
 *
 * Les tests utilisent une **vraie clé RSA** générée à la volée et un `fetch`
 * simulé : la signature JWT, l'échange de jeton OAuth2 et la requête multipart
 * d'upload sont donc réellement exercés (aucune dépendance `googleapis`).
 * Le `fetch` simulé ne sort pas du réseau : aucune donnée réelle n'est envoyée.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { startTestServer, login, api } = require('./helpers');
const { GoogleDriveClient, signServiceAssertion } = require('../src/services/google-drive');
const { backupToDrive, buildBackup, serializeBackup } = require('../src/services/backup');

/** Génère un couple de clés RSA temporaire (clé privée PEM). */
const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const SERVICE_EMAIL = 'backup-bot@project.iam.gserviceaccount.com';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const ACCESS_TOKEN = 'ya29.test-token';

/** Record d'un `fetch` simulé : capture les appels, renvoie des réponses plausibles. */
function fakeFetch({ failUpload = false, failToken = false } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    const json = (body, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    });
    if (String(url).startsWith(TOKEN_URI)) {
      if (failToken) return json({ error: 'invalid_grant' }, 400);
      return json({ access_token: ACCESS_TOKEN, expires_in: 3600, token_type: 'Bearer' });
    }
    if (String(url).includes('/upload/drive/v3/files')) {
      if (failUpload) return json({ error: { message: 'Insufficient permissions' } }, 403);
      return json({ id: 'drive-file-1', name: 'scoot-backup.json', webViewLink: 'https://drive.google.com/file/d/drive-file-1/view' }, 200);
    }
    if (String(url).includes('/drive/v3/files')) {
      return json({ files: [{ id: 'drive-file-1', name: 'scoot-backup-2026.json', size: '1234', createdTime: '2026-09-22T00:00:00.000Z' }] });
    }
    return json({ error: 'unexpected url' }, 404);
  };
  impl.calls = calls;
  return impl;
}

function makeClient(fetchImpl, overrides = {}) {
  return new GoogleDriveClient({
    clientEmail: SERVICE_EMAIL,
    privateKey,
    folderId: 'folder-123',
    tokenUri: TOKEN_URI,
    fetchImpl,
    ...overrides,
  });
}

test('sauvegarde Google Drive : compte de service, dump complet, CRON admin', async (t) => {
  const srv = await startTestServer();
  try {
    await t.test('la clé privée multi-lignes est acceptée (JWT RS256 signé)', async () => {
      const assertion = signServiceAssertion({
        clientEmail: SERVICE_EMAIL, privateKey, tokenUri: TOKEN_URI, now: 1_700_000_000,
      });
      const [header, claim, sig] = assertion.split('.');
      const decode = (s) => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      assert.equal(decode(header).alg, 'RS256');
      assert.equal(decode(claim).iss, SERVICE_EMAIL);
      assert.equal(decode(claim).aud, TOKEN_URI);
      assert.ok(sig.length > 0);
    });

    await t.test('le client échange le JWT contre un jeton puis téléverse (multipart)', async () => {
      const fetchImpl = fakeFetch();
      const client = makeClient(fetchImpl);
      assert.equal(client.configured, true);

      const result = await client.uploadFile({ name: 'scoot.json', content: '{"a":1}' });
      assert.equal(result.id, 'drive-file-1');

      // 1er appel : échange du jeton ; 2e : upload multipart.
      assert.equal(fetchImpl.calls.length, 2);
      assert.ok(String(fetchImpl.calls[0].url).startsWith(TOKEN_URI));
      assert.match(String(fetchImpl.calls[0].options.body), /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);

      const upload = fetchImpl.calls[1];
      assert.match(String(upload.url), /upload\/drive\/v3\/files\?uploadType=multipart/);
      assert.equal(upload.options.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
      assert.match(String(upload.options.headers['Content-Type']), /multipart\/related; boundary=/);
      assert.ok(Buffer.isBuffer(upload.options.body));
      assert.match(upload.options.body.toString('utf8'), /"parents":\["folder-123"\]/);
    });

    await t.test('un compte de service non configuré est signalé clairement', async () => {
      const client = new GoogleDriveClient({ clientEmail: '', privateKey: '', fetchImpl: fakeFetch() });
      assert.equal(client.configured, false);
      await assert.rejects(() => client.uploadFile({ name: 'x', content: '{}' }), /non configuré/);
    });

    await t.test('dump complet : toutes les entités, sans hash de mot de passe', async () => {
      const admin = await login(srv.base);
      const full = await (await fetch(srv.base + '/api/exports/backup', {
        headers: { Authorization: 'Bearer ' + admin.token },
      })).json();
      assert.ok(full.bikes.length >= 8 && full.customers.length >= 5 && full.sales.length >= 3);
      assert.ok(full.sales[0].items, 'les lignes de vente sont incluses');

      const dump = buildBackup(srv.db);
      assert.ok(dump.users.length >= 2);
      assert.ok(dump.users.every((u) => !('password_hash' in u)), 'aucun hash de mot de passe exporté');
      assert.deepEqual(Object.keys(dump.counts).sort(), ['bikes', 'customers', 'sales', 'users']);
    });

    await t.test('sérialisation JSON et CSV', async () => {
      const json = serializeBackup(srv.db, { format: 'json' });
      assert.match(json.name, /^scoot-backup-.*\.json$/);
      assert.equal(json.mimeType, 'application/json');
      assert.ok(JSON.parse(json.content).bikes.length >= 8);

      const csv = serializeBackup(srv.db, { format: 'csv' });
      assert.match(csv.name, /^scoot-backup-.*\.csv$/);
      assert.match(csv.content, /# motos/);
      assert.match(csv.content, /# clients/);
      assert.match(csv.content, /# ventes/);
    });

    await t.test('backupToDrive : upload réel (simulé) et métadonnées', async () => {
      const fetchImpl = fakeFetch();
      const client = makeClient(fetchImpl);
      const result = await backupToDrive(srv.db, { client, format: 'json', exportedBy: 'user-1' });
      assert.equal(result.ok, true);
      assert.equal(result.file.id, 'drive-file-1');
      assert.equal(result.format, 'json');
      assert.ok(result.size > 0);
      assert.ok(result.counts.bikes >= 8);
    });

    await t.test('POST /api/exports/backup/drive : admin seulement, 502 si Drive refuse', async () => {
      // La route construit son propre client depuis la config ; on la teste donc
      // via le point d'entrée API avec un compte non configuré (403 admin puis 502).
      const seller = await login(srv.base, 'vendeur', 'vendeur123');
      const forbidden = await api(srv.base, seller.token, 'POST', '/api/exports/backup/drive', {});
      assert.equal(forbidden.status, 403);

      const anon = await api(srv.base, null, 'POST', '/api/exports/backup/drive', {});
      assert.equal(anon.status, 401);

      // Admin, mais compte de service absent dans l'environnement de test → 502 explicite.
      const admin = await login(srv.base);
      const noAccount = await api(srv.base, admin.token, 'POST', '/api/exports/backup/drive', {});
      assert.equal(noAccount.status, 502);
      assert.match(noAccount.body.error, /compte de service/i);
    });

    await t.test('GET /api/exports/backup/drive : admin seulement, 503 si non configuré', async () => {
      const seller = await login(srv.base, 'vendeur', 'vendeur123');
      assert.equal((await api(srv.base, seller.token, 'GET', '/api/exports/backup/drive')).status, 403);
      const admin = await login(srv.base);
      assert.equal((await api(srv.base, admin.token, 'GET', '/api/exports/backup/drive')).status, 503);
    });

    await t.test('listFiles : diagnostic admin (liste simulée)', async () => {
      const client = makeClient(fakeFetch());
      const files = await client.listFiles({ max: 10 });
      assert.equal(files.length, 1);
      assert.equal(files[0].id, 'drive-file-1');
    });
  } finally {
    await srv.close();
  }
});
