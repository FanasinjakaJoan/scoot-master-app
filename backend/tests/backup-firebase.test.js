'use strict';

/**
 * Sauvegarde Firebase — tests du vrai code de sauvegarde/restauration.
 *
 * Aucun mock de module : on injecte un « bucket » en mémoire qui implémente
 * l'API réellement utilisée par `services/firebase.js` (save/download/getFiles/
 * delete). Ce sont donc bien les chemins réels (sérialisation, réessais,
 * rotation, fusion) qui sont exercés — sans réseau ni compte de service.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { initDb } = require('../src/db/init');
const { createBackupService, createBackupScheduler, restoreSnapshot } = require('../src/services/backup');
const { createFirebaseService } = require('../src/services/firebase');
const { startTestServer, login, api } = require('./helpers');

/** Bucket Cloud Storage en mémoire, suffisant pour les appels du service. */
function memoryBucket({ failUploads = 0 } = {}) {
  const objects = new Map();
  let uploads = 0;
  return {
    objects,
    uploaded: () => uploads,
    file(name) {
      return {
        async save(buffer, opts = {}) {
          if (uploads++ < failUploads) throw new Error('panne réseau simulée');
          const meta = opts.metadata || {};
          objects.set(name, {
            buffer: Buffer.from(buffer),
            metadata: {
              size: buffer.length,
              updated: new Date().toISOString(),
              contentType: opts.contentType,
              metadata: meta.metadata || {},
            },
          });
        },
        async download() {
          const obj = objects.get(name);
          if (!obj) throw new Error(`objet introuvable : ${name}`);
          return [obj.buffer];
        },
        async delete() { objects.delete(name); },
      };
    },
    async getFiles({ prefix } = {}) {
      const files = [...objects.entries()]
        .filter(([name]) => !prefix || name.startsWith(prefix))
        .map(([name, obj]) => ({ name, metadata: obj.metadata }));
      return [files];
    },
  };
}

function buildService(db, bucket, overrides = {}) {
  const backup = { prefix: 'backups/', retention: 30, enabled: true, ready: true, ...overrides.backup };
  const serviceAccount = { projectId: 'demo', clientEmail: 'svc@demo.iam.gserviceaccount.com', privateKey: 'kj' };
  const firebase = createFirebaseService({ serviceAccount, backup, bucket });
  return createBackupService({
    db,
    backup,
    firebase,
    logger: { log() {}, warn() {}, error() {} },
    delay: async () => {},
    ...overrides,
  });
}

test('sauvegarde Firebase — service de sauvegarde', async (t) => {
  await t.test('téléverse un instantané complet et enregistre les métadonnées', async () => {
    const db = initDb({ dbPath: ':memory:', seedOnStart: true });
    const bucket = memoryBucket();
    const svc = buildService(db, bucket);

    const result = await svc.run({ reason: 'manual', actor: { id: 'u1', username: 'admin', role: 'admin' } });

    assert.equal(result.status, 'success');
    assert.match(result.path, /^backups\/scoot-backup-\d{4}-\d{2}-\d{2}T[\d-]+\.json$/);
    assert.ok(result.size > 0, 'la taille du fichier est enregistrée');
    assert.equal(result.reason, 'manual');
    assert.equal(result.actor, 'admin');
    assert.ok(result.startedAt && result.finishedAt, 'date et heure du run');
    assert.equal(typeof result.durationMs, 'number');

    const [stored] = [...bucket.objects.values()];
    const snapshot = JSON.parse(stored.buffer.toString('utf8'));
    assert.equal(snapshot.app, 'scoot-master');
    assert.equal(snapshot.reason, 'manual');
    assert.ok(snapshot.bikes.length >= 8);
    assert.ok(snapshot.sales[0].items, 'les lignes de vente sont incluses');
    assert.equal(stored.metadata.metadata.app, 'scoot-master');
    assert.equal(stored.metadata.metadata.status, 'success');
  });

  await t.test('réessaie le téléversement en cas d’échec réseau puis réussit', async () => {
    const db = initDb({ dbPath: ':memory:', seedOnStart: true });
    const bucket = memoryBucket({ failUploads: 2 });
    const svc = buildService(db, bucket);

    const result = await svc.run({ reason: 'scheduled' });

    assert.equal(result.status, 'success');
    assert.equal(result.attempts, 3, 'deux échecs puis succès');
    assert.equal(bucket.uploaded(), 3);
    assert.equal(bucket.objects.size, 1, 'un seul objet final');
  });

  await t.test('échoue proprement après épuisement des tentatives (statut failure)', async () => {
    const db = initDb({ dbPath: ':memory:', seedOnStart: true });
    const bucket = memoryBucket({ failUploads: 99 });
    const svc = buildService(db, bucket);

    const result = await svc.run({ reason: 'scheduled' });

    assert.equal(result.status, 'failure');
    assert.ok(result.error, 'le motif de l’échec est conservé');
    assert.equal(bucket.objects.size, 0);
    assert.equal(svc.state().history[0].status, 'failure');
  });

  await t.test('applique la rotation (retention) sur les seules sauvegardes Scoot Master', async () => {
    const db = initDb({ dbPath: ':memory:', seedOnStart: true });
    const bucket = memoryBucket();
    const svc = buildService(db, bucket, { backup: { prefix: 'backups/', retention: 2, enabled: true, ready: true } });

    // Un objet étranger partage le préfixe : il ne doit jamais être supprimé.
    bucket.objects.set('backups/autre-fichier.json', {
      buffer: Buffer.from('{}'),
      metadata: { size: 2, updated: '2020-01-01T00:00:00.000Z', metadata: {} },
    });

    await svc.run({ reason: 'scheduled' });
    await new Promise((r) => setTimeout(r, 1100));
    await svc.run({ reason: 'scheduled' });
    await new Promise((r) => setTimeout(r, 1100));
    const third = await svc.run({ reason: 'scheduled' });

    assert.equal(third.status, 'success');
    assert.equal(third.pruned.length, 1, 'la plus ancienne sauvegarde est supprimée');
    const remaining = [...bucket.objects.keys()];
    assert.ok(remaining.includes('backups/autre-fichier.json'), 'fichier étranger préservé');
    assert.equal(remaining.filter((n) => n.includes('scoot-backup')).length, 2);
  });

  await t.test('ne se chevauche pas : un second run pendant le premier est « skipped »', async () => {
    const db = initDb({ dbPath: ':memory:', seedOnStart: true });
    const bucket = memoryBucket();
    let release;
    const gate = new Promise((r) => { release = r; });
    // Bloque le téléversement pendant que le second run tente sa chance.
    const originalFile = bucket.file.bind(bucket);
    bucket.file = (name) => {
      const f = originalFile(name);
      const save = f.save.bind(f);
      f.save = async (buf, opts) => { await gate; return save(buf, opts); };
      return f;
    };
    const svc = buildService(db, bucket);

    const first = svc.run({ reason: 'manual' });
    const second = await svc.run({ reason: 'manual' });

    assert.equal(second.status, 'skipped');
    assert.match(second.error, /déjà en cours/);
    release();
    const firstResult = await first;
    assert.equal(firstResult.status, 'success');
    assert.equal(bucket.objects.size, 1, 'un seul objet téléversé');
  });

  await t.test('reste « skipped » avec une raison explicite quand Firebase n’est pas configuré', async () => {
    const db = initDb({ dbPath: ':memory:', seedOnStart: true });
    const svc = createBackupService({
      db,
      backup: { enabled: false, ready: false, bucket: '', prefix: 'backups/', retention: 30 },
      firebase: createFirebaseService({ serviceAccount: {}, backup: { bucket: '', prefix: 'backups/' }, bucket: memoryBucket() }),
      logger: { log() {}, warn() {}, error() {} },
    });

    const disabled = await svc.run({ reason: 'scheduled' });
    assert.equal(disabled.status, 'skipped');
    assert.match(disabled.error, /désactivée/);

    const partial = createBackupService({
      db,
      backup: { enabled: true, ready: false, bucket: '', prefix: 'backups/', retention: 30 },
      firebase: createFirebaseService({ serviceAccount: {}, backup: { bucket: '', prefix: 'backups/' }, bucket: memoryBucket() }),
      logger: { log() {}, warn() {}, error() {} },
    });
    const incomplete = await partial.run({ reason: 'scheduled' });
    assert.equal(incomplete.status, 'skipped');
    assert.match(incomplete.error, /incomplète/);
  });

  await t.test('restaure un fichier précis : fusion par identifiant, tombstones et lignes de vente', async () => {
    const source = initDb({ dbPath: ':memory:', seedOnStart: true });
    const bucket = memoryBucket();
    const svc = buildService(source, bucket);
    const run = await svc.run({ reason: 'manual' });

    // Cible vide : la première restauration installe le jeu de données.
    const target = initDb({ dbPath: ':memory:', seedOnStart: false });
    const restoreSvc = buildService(target, bucket);
    const first = await restoreSvc.restore(run.path);
    assert.deepEqual(
      { bikes: first.applied.bikes, customers: first.applied.customers, sales: first.applied.sales, items: first.applied.sale_items },
      { bikes: run.counts.bikes, customers: run.counts.customers, sales: run.counts.sales, items: run.counts.sale_items }
    );

    // On dérive la base : un enregistrement modifié doit être écrasé par la
    // version restaurée, un enregistrement créé depuis doit survivre (la
    // restauration ne supprime rien).
    const yamahaId = source.prepare("SELECT id FROM bikes WHERE brand = 'Yamaha'").get().id;
    target.prepare('UPDATE bikes SET price = 1 WHERE id = ?').run(yamahaId);
    target.prepare(
      `INSERT INTO customers (id, first_name, last_name, phone, created_at, updated_at, version)
       VALUES ('nouveau', 'Nouveau', 'Client', '0340', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0)`
    ).run();

    const outcome = await restoreSvc.restore(run.path);

    assert.equal(outcome.applied.bikes, run.counts.bikes);
    assert.equal(outcome.applied.customers, run.counts.customers);
    assert.equal(outcome.applied.sales, run.counts.sales);
    assert.equal(outcome.applied.sale_items, run.counts.sale_items);
    const yamaha = target.prepare('SELECT price FROM bikes WHERE id = ?').get(yamahaId);
    assert.equal(yamaha.price, source.prepare('SELECT price FROM bikes WHERE id = ?').get(yamahaId).price);
    assert.ok(target.prepare("SELECT 1 FROM customers WHERE id = 'nouveau'").get(), 'le client créé après reste présent');
  });

  await t.test('la restauration se propage au pull : horodatages remis à l’heure, tombstones inclus', async () => {
    const { pullChanges } = require('../src/services/sync');
    const source = initDb({ dbPath: ':memory:', seedOnStart: true });
    const bucket = memoryBucket();
    // Une moto supprimée avant la sauvegarde : son tombstone doit voyager.
    const doomedId = source.prepare("SELECT id FROM bikes WHERE brand = 'Yamaha'").get().id;
    source.prepare("UPDATE bikes SET deleted_at = ?, updated_at = ? WHERE id = ?")
      .run('2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', doomedId);
    const run = await buildService(source, bucket).run({ reason: 'manual' });

    const target = initDb({ dbPath: ':memory:', seedOnStart: false });
    // Curseur d'un client déjà synchronisé : plus récent que les données du
    // fichier. Sans remise à l'heure, le pull ne verrait aucun changement.
    const cursor = '2026-09-22T09:00:00.000Z';
    const before = pullChanges(target, { since: cursor });
    assert.equal(before.changes.length, 0, 'aucun changement avant restauration');

    await buildService(target, bucket).restore(run.path);

    const after = pullChanges(target, { since: cursor });
    const ids = new Set(after.changes.map((c) => `${c.entity}:${c.id}`));
    assert.ok(ids.has(`bikes:${doomedId}`), 'le tombstone restauré est renvoyé au pull');
    const deleted = after.changes.find((c) => c.id === doomedId);
    assert.equal(deleted.op, 'delete', 'un enregistrement supprimé revient en delete, pas en upsert actif');
    assert.ok(deleted.updatedAt > cursor, 'horodatage postérieur au curseur du client');
    assert.ok(after.changes.length >= run.counts.bikes + run.counts.customers, 'toutes les entités restaurées sont propagées');
  });

  await t.test('signale une ligne en conflit de clé unique sans interrompre la restauration', async () => {
    const source = initDb({ dbPath: ':memory:', seedOnStart: true });
    const bucket = memoryBucket();
    const run = await buildService(source, bucket).run({ reason: 'manual' });

    // Cible avec une vente au même numéro de bon mais à un identifiant différent :
    // la contrainte UNIQUE doit rejeter cette ligne — et seulement celle-là.
    const target = initDb({ dbPath: ':memory:', seedOnStart: false });
    const [sale] = run.counts.sales ? [source.prepare('SELECT * FROM sales LIMIT 1').get()] : [];
    target.prepare(
      `INSERT INTO customers (id, first_name, last_name, phone, created_at, updated_at, version)
       VALUES ('c-x', 'X', 'Y', '0340', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0)`
    ).run();
    target.prepare(
      `INSERT INTO sales (id, sale_number, customer_id, total, sale_date, created_at, updated_at, version)
       VALUES ('autre-id', ?, 'c-x', 0, '2026-01-01', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0)`
    ).run(sale.sale_number);

    const outcome = await buildService(target, bucket).restore(run.path);

    assert.equal(outcome.applied.skipped.length, 1);
    assert.equal(outcome.applied.skipped[0].table, 'sales');
    assert.match(outcome.applied.skipped[0].reason, /UNIQUE constraint failed: sales\.sale_number/);
    assert.equal(outcome.applied.bikes, run.counts.bikes, 'le reste du fichier est bien restauré');
  });

  await t.test('rejette un fichier de restauration illisible ou invalide', async () => {
    const db = initDb({ dbPath: ':memory:', seedOnStart: true });
    const bucket = memoryBucket();
    bucket.objects.set('backups/bad.json', {
      buffer: Buffer.from('pas du json'),
      metadata: { size: 11, updated: new Date().toISOString(), metadata: {} },
    });
    const svc = buildService(db, bucket);

    await assert.rejects(() => svc.restore('backups/bad.json'), /illisible/);
    await assert.rejects(() => svc.restore(''), /Chemin de sauvegarde requis/);
    assert.throws(() => restoreSnapshot(db, { app: 'autre' }), /invalide/);
  });

  await t.test('expose l’état (enabled, bucket, intervalle, dernier run, historique)', async () => {
    const db = initDb({ dbPath: ':memory:', seedOnStart: true });
    const svc = buildService(db, memoryBucket(), {
      backup: { prefix: 'backups/', retention: 7, enabled: true, ready: true, bucket: 'scoot-backups', intervalHours: 12, firestoreExport: false },
    });
    await svc.run({ reason: 'manual' });

    const state = svc.state();
    assert.equal(state.enabled, true);
    assert.equal(state.ready, true);
    assert.equal(state.bucket, 'scoot-backups');
    assert.equal(state.intervalHours, 12);
    assert.equal(state.retention, 7);
    assert.equal(state.mode, 'json');
    assert.equal(state.lastRun.status, 'success');
    assert.equal(state.history.length, 1);
  });

  await t.test('mode Firestore : délègue à l’export natif sans sérialiser la base', async () => {
    const db = initDb({ dbPath: ':memory:', seedOnStart: true });
    const calls = [];
    const firebase = {
      async exportFirestore(collectionIds) {
        calls.push(collectionIds);
        return { name: 'projects/demo/operations/123' };
      },
      async pruneBackups() { return []; },
    };
    const svc = createBackupService({
      db,
      backup: { enabled: true, ready: true, bucket: 'b', prefix: 'backups/', retention: 5, firestoreExport: true },
      firebase,
      logger: { log() {}, warn() {}, error() {} },
    });

    const result = await svc.run({ reason: 'scheduled', kind: 'firestore', collectionIds: ['bikes'] });
    assert.equal(result.status, 'success');
    assert.equal(result.kind, 'firestore');
    assert.equal(result.operation, 'projects/demo/operations/123');
    assert.deepEqual(calls, [['bikes']]);
  });
});

test('sauvegarde Firebase — planificateur automatique', async (t) => {
  await t.test('déclenche des runs planifiés et s’arrête proprement', async () => {
    const reasons = [];
    const service = {
      async run({ reason }) { reasons.push(reason); return { status: 'success', finishedAt: new Date().toISOString() }; },
      state: () => ({ lastRun: null }),
    };
    const scheduler = createBackupScheduler({ service, intervalHours: 1, initialDelayMs: 5, logger: { log() {} } });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 30));
    scheduler.stop();
    const count = reasons.length;
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(count >= 1, 'un run planifié a été déclenché');
    assert.equal(reasons[0], 'scheduled');
    assert.equal(reasons.length, count, 'plus aucun run après stop()');
  });
});

test('sauvegarde Firebase — routes API (admin)', async (t) => {
  const db = initDb({ dbPath: ':memory:', seedOnStart: true });
  const bucket = memoryBucket();
  const backupService = buildService(db, bucket, {
    backup: { prefix: 'backups/', retention: 30, enabled: true, ready: true, bucket: 'scoot-backups' },
  });
  const srv = await startTestServer({ backupService });
  const { token: adminToken } = await login(srv.base, 'admin', 'admin123');
  const { token: sellerToken } = await login(srv.base, 'vendeur', 'vendeur123');

  try {
    await t.test('GET /api/exports/backups/firebase expose l’état (admin)', async () => {
      const res = await api(srv.base, adminToken, 'GET', '/api/exports/backups/firebase');
      assert.equal(res.status, 200);
      assert.equal(res.body.ready, true);
      assert.equal(res.body.bucket, 'scoot-backups');
    });

    await t.test('POST déclenche une sauvegarde manuelle et la liste ensuite', async () => {
      const created = await api(srv.base, adminToken, 'POST', '/api/exports/backups/firebase');
      assert.equal(created.status, 201);
      assert.equal(created.body.status, 'success');
      assert.equal(created.body.reason, 'manual');
      assert.equal(created.body.actor, 'admin');

      const files = await api(srv.base, adminToken, 'GET', '/api/exports/backups/firebase/files');
      assert.equal(files.status, 200);
      assert.ok(files.body.items.some((f) => f.path === created.body.path));
    });

    await t.test('restauration via l’API avec un chemin précis', async () => {
      const backupPath = [...bucket.objects.keys()].find((n) => n.includes('scoot-backup'));
      const res = await api(srv.base, adminToken, 'POST', '/api/exports/backups/firebase/restore', { path: backupPath });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.ok(res.body.applied.bikes >= 1);

      const bad = await api(srv.base, adminToken, 'POST', '/api/exports/backups/firebase/restore', {});
      assert.equal(bad.status, 400);
    });

    await t.test('les routes de sauvegarde Firebase sont réservées aux admins', async () => {
      assert.equal((await api(srv.base, sellerToken, 'GET', '/api/exports/backups/firebase')).status, 403);
      assert.equal((await api(srv.base, sellerToken, 'POST', '/api/exports/backups/firebase')).status, 403);
    });

    await t.test('une sauvegarde ignorée répond 200 (résultat valide, pas une panne)', async () => {
      const disabled = createBackupService({
        db,
        backup: { enabled: false, ready: false, bucket: '', prefix: 'backups/', retention: 30 },
        firebase: createFirebaseService({ serviceAccount: {}, backup: { bucket: '', prefix: 'backups/' }, bucket: memoryBucket() }),
        logger: { log() {}, warn() {}, error() {} },
      });
      const srv2 = await startTestServer({ backupService: disabled });
      try {
        const { token: t2 } = await login(srv2.base, 'admin', 'admin123');
        const res = await api(srv2.base, t2, 'POST', '/api/exports/backups/firebase');
        assert.equal(res.status, 200);
        assert.equal(res.body.status, 'skipped');
      } finally {
        await srv2.close();
      }
    });

    await t.test('refuse un déclenchement sans authentification', async () => {
      assert.equal((await api(srv.base, null, 'POST', '/api/exports/backups/firebase')).status, 401);
    });

    await t.test('Firebase non configuré : 409 explicite (jamais de 500 ni de message SDK brut)', async () => {
      // Service délibérément non configuré : c'est ici que, sans garde-fou,
      // `/files` toucherait le SDK et renverrait en 500 son message interne
      // (« Service account object must contain a string "project_id" »).
      const unconfigured = createBackupService({
        db,
        backup: { enabled: false, ready: false, bucket: '', prefix: 'backups/', retention: 30 },
        firebase: null,
        logger: { log() {}, warn() {}, error() {} },
      });
      const srv3 = await startTestServer({ backupService: unconfigured });
      try {
        const { token: t3 } = await login(srv3.base, 'admin', 'admin123');

        const files = await api(srv3.base, t3, 'GET', '/api/exports/backups/firebase/files');
        assert.equal(files.status, 409);
        assert.match(files.body.error, /non configurée/i);
        assert.ok(!/project_id/.test(files.body.error));

        const restore = await api(srv3.base, t3, 'POST', '/api/exports/backups/firebase/restore', {
          path: 'backups/scoot-backup-2026-09-22T10-00-00.json',
        });
        assert.equal(restore.status, 409);
        assert.match(restore.body.error, /non configurée/i);

        // `GET /files` reste protégé par le rôle avant même le garde-fou.
        const { token: sellerOnSrv3 } = await login(srv3.base, 'vendeur', 'vendeur123');
        assert.equal((await api(srv3.base, sellerOnSrv3, 'GET', '/api/exports/backups/firebase/files')).status, 403);
      } finally {
        await srv3.close();
      }
    });
  } finally {
    await srv.close();
  }
});

test('sauvegarde Firebase — migration de clé privée et construction du bucket', async (t) => {
  await t.test('les \\n littéraux de FIREBASE_PRIVATE_KEY sont convertis en sauts de ligne', () => {
    // Reproduit la lecture d'environnement faite par config.js : les `\n`
    // littéraux (2 caractères) deviennent de vrais sauts de ligne.
    const raw = '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n';
    const converted = raw.replace(/\\n/g, '\n');
    assert.equal(converted.split('\n').length, 4);
    assert.ok(!converted.includes('\\n'));
  });

  await t.test('construit le bucket via le SDK réel (API modulaire firebase-admin)', () => {
    const crypto = require('node:crypto');
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const svc = createFirebaseService({
      serviceAccount: {
        projectId: 'demo-project',
        clientEmail: 'svc@demo-project.iam.gserviceaccount.com',
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      },
      backup: { bucket: 'scoot-backups', prefix: 'backups/' },
    });
    assert.equal(svc.getBucket().name, 'scoot-backups');
  });

  await t.test('accepte un SDK injecté (surface normalisée cert/initializeApp/getStorage)', () => {
    const calls = [];
    const fakeBucket = { name: 'injecte' };
    const fakeAdmin = {
      getApps: () => [],
      getApp: () => { throw new Error('non appelé'); },
      initializeApp: (opts) => { calls.push(opts); return { name: '[DEFAULT]' }; },
      cert: (sa) => ({ sa }),
      getStorage: () => ({ bucket: (name) => ({ ...fakeBucket, name }) }),
    };
    const svc = createFirebaseService({
      serviceAccount: { projectId: 'p', clientEmail: 'e', privateKey: 'k' },
      backup: { bucket: 'b', prefix: 'backups/' },
      admin: fakeAdmin,
    });
    assert.equal(svc.getBucket().name, 'b');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].credential.sa.projectId, 'p');
  });
});

test('sauvegarde Firebase — export Firestore (OAuth + API REST)', async (t) => {
  const { createFirebaseService, _resetTokenCache } = require('../src/services/firebase');

  await t.test('signe un JWT RS256, obtient un jeton puis appelle exportDocuments', async () => {
    const crypto = require('node:crypto');
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    _resetTokenCache();

    const seen = [];
    const request = async (opts) => {
      seen.push(`${opts.method} ${opts.host}${opts.path}`);
      if (opts.path === '/token') {
        // La signature RS256 doit être vérifiable — gage que le JWT est valide.
        const assertion = new URLSearchParams(opts.body).get('assertion');
        const [h, c, s] = assertion.split('.');
        const verify = crypto.createVerify('RSA-SHA256').update(`${h}.${c}`);
        assert.ok(verify.verify(privateKey, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')));
        return { statusCode: 200, body: JSON.stringify({ access_token: 'tok', expires_in: 3600 }) };
      }
      return { statusCode: 200, body: JSON.stringify({ name: 'projects/p/operations/1' }) };
    };

    const svc = createFirebaseService({
      serviceAccount: { projectId: 'p', clientEmail: 'svc@p.iam.gserviceaccount.com', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) },
      backup: { bucket: 'scoot-backups', prefix: 'backups/' },
      bucket: memoryBucket(),
      request,
    });

    const op = await svc.exportFirestore(['bikes'], 'backups/');
    assert.equal(op.name, 'projects/p/operations/1');
    assert.deepEqual(seen, [
      'POST oauth2.googleapis.com/token',
      'POST firestore.googleapis.com/v1/projects/p/databases/(default):exportDocuments',
    ]);
    // Le jeton est mis en cache : le second appel ne redemande pas d'OAuth.
    await svc.exportFirestore();
    assert.equal(seen.filter((s) => s.includes('oauth2')).length, 1);
  });

  await t.test('propage une erreur lisible quand l’export est refusé', async () => {
    _resetTokenCache();
    const crypto = require('node:crypto');
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const request = async (opts) =>
      opts.path === '/token'
        ? { statusCode: 200, body: JSON.stringify({ access_token: 'tok', expires_in: 3600 }) }
        : { statusCode: 403, body: JSON.stringify({ error: { message: 'permission denied' } }) };
    const svc = createFirebaseService({
      serviceAccount: { projectId: 'p', clientEmail: 'svc@p.iam.gserviceaccount.com', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) },
      backup: { bucket: 'b', prefix: 'backups/' },
      bucket: memoryBucket(),
      request,
    });
    await assert.rejects(() => svc.exportFirestore(), /Export Firestore refusé \(403\): permission denied/);
  });
});

test('sauvegarde Firebase — test de bout en bout sur fichier SQLite réel', async (t) => {
  await t.test('sauvegarde puis restauration dans une base distincte (fichiers temporaires)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoot-backup-'));
    const srcPath = path.join(dir, 'source.db');
    const dstPath = path.join(dir, 'cible.db');
    const bucket = memoryBucket();
    try {
      const source = initDb({ dbPath: srcPath, seedOnStart: true });
      const svc = buildService(source, bucket);
      const run = await svc.run({ reason: 'manual', actor: { id: 'u1', username: 'admin', role: 'admin' } });
      assert.equal(run.status, 'success');
      source.close();

      const target = initDb({ dbPath: dstPath, seedOnStart: false });
      const restoreSvc = buildService(target, bucket);
      const outcome = await restoreSvc.restore(run.path);
      assert.equal(outcome.applied.bikes, run.counts.bikes);
      assert.equal(outcome.applied.customers, run.counts.customers);
      assert.equal(outcome.applied.sales, run.counts.sales);
      assert.equal(outcome.applied.sale_items, run.counts.sale_items);
      assert.equal(outcome.applied.skipped.length, 0);
      assert.equal(target.prepare('SELECT COUNT(*) AS n FROM bikes').get().n, run.counts.bikes);
      assert.equal(target.prepare('SELECT COUNT(*) AS n FROM sale_items').get().n, run.counts.sale_items);
      target.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
