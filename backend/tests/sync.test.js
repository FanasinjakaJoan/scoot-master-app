'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startTestServer, login, api } = require('./helpers');

const DEVICE_A = 'device-phone-A';
const DEVICE_B = 'device-phone-B';

/** Horodatages relatifs à l'heure réelle du serveur (comparaison LWW honnête). */
const nowIso = () => new Date().toISOString();
const pastIso = (ms) => new Date(Date.now() - ms).toISOString();
const H = 3600e3;

test('sync : push hors ligne, LWW, conflits, force, pull, tombstones', async (t) => {
  const srv = await startTestServer({ seed: 'users' }); // base vide (comptes seulement) : tout est créé « hors ligne »
  const admin = await login(srv.base);
  const seller = await login(srv.base, 'vendeur', 'vendeur123');
  try {
    await t.test('push : création hors ligne d\u2019un client, d\u2019une moto et d\u2019une vente', async () => {
      const customerOp = {
        entity: 'customers', op: 'create', id: 'c-0001',
        payload: { first_name: 'Rija', last_name: 'Ando', phone: '+261 34 11 22 33' },
        clientTs: pastIso(3 * H),
      };
      const bikeOp = {
        entity: 'bikes', op: 'create', id: 'b-0001',
        payload: { brand: 'Yamaha', model: 'XT 125', price: 2500000, mileage_km: 12000, status: 'available' },
        clientTs: pastIso(3 * H),
      };
      const saleOp = {
        entity: 'sales', op: 'create', id: 's-0001',
        payload: {
          customer_id: 'c-0001', status: 'confirme', sale_date: new Date().toISOString().slice(0, 10),
          amount_paid: 2500000, payment_method: 'cash',
          items: [{ bike_id: 'b-0001', unit_price: 2500000, quantity: 1 }],
        },
        clientTs: pastIso(3 * H),
      };

      const res = await api(srv.base, admin.token, 'POST', '/api/sync/push', {
        deviceId: DEVICE_A, operations: [customerOp, bikeOp, saleOp],
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.results.map((r) => r.status), ['ok', 'ok', 'ok']);
      assert.equal(res.body.stats.conflicts, 0);
      assert.ok(res.body.results[2].saleNumber.startsWith('BC-'));

      // La vente confirmée doit passer la moto en sold (effet de domaine serveur)
      const bike = await api(srv.base, admin.token, 'GET', '/api/bikes/b-0001');
      assert.equal(bike.body.bike.status, 'sold');
      const sale = await api(srv.base, admin.token, 'GET', '/api/sales/s-0001');
      assert.equal(sale.body.sale.total, 2500000);
      assert.equal(sale.body.sale.payment_status, 'paid');
      assert.equal(sale.body.sale.items.length, 1);
    });

    await t.test('LWW : opération plus ancienne que le serveur → conflit', async () => {
      const serverEdit = await api(srv.base, admin.token, 'PUT', '/api/bikes/b-0001', { price: 2600000, status: 'available' });
      assert.equal(serverEdit.status, 200);

      // L'app A pousse une modification faite AVANT l'édition serveur
      const res = await api(srv.base, admin.token, 'POST', '/api/sync/push', {
        deviceId: DEVICE_A,
        operations: [{
          entity: 'bikes', op: 'update', id: 'b-0001',
          payload: { price: 2400000 }, clientTs: pastIso(1 * H), // plus ancienne
        }],
      });
      assert.equal(res.body.results[0].status, 'conflict');
      assert.equal(res.body.results[0].server.price, 2600000);
      assert.equal(res.body.stats.conflicts, 1);

      // Le prix serveur est inchangé
      const bike = await api(srv.base, admin.token, 'GET', '/api/bikes/b-0001');
      assert.equal(bike.body.bike.price, 2600000);
    });

    await t.test('LWW : opération plus récente que le serveur → appliquée', async () => {
      const res = await api(srv.base, admin.token, 'POST', '/api/sync/push', {
        deviceId: DEVICE_A,
        operations: [{
          entity: 'bikes', op: 'update', id: 'b-0001',
          payload: { price: 2650000 }, clientTs: nowIso(), // plus récente que l'édition serveur
        }],
      });
      assert.equal(res.body.results[0].status, 'ok');
      const bike = await api(srv.base, admin.token, 'GET', '/api/bikes/b-0001');
      assert.equal(bike.body.bike.price, 2650000);
    });

    await t.test('force : vendeur ignoré, admin applique malgré le conflit', async () => {
      await api(srv.base, admin.token, 'PUT', '/api/bikes/b-0001', { price: 2700000 });

      // Vendeur force une version ancienne → force ignoré (pas admin)
      const asSeller = await api(srv.base, seller.token, 'POST', '/api/sync/push', {
        deviceId: DEVICE_B,
        operations: [{
          entity: 'bikes', op: 'update', id: 'b-0001', force: true,
          payload: { price: 2000000 }, clientTs: pastIso(2 * H),
        }],
      });
      assert.equal(asSeller.body.results[0].status, 'conflict');

      // Admin force la validation → appliquée
      const asAdmin = await api(srv.base, admin.token, 'POST', '/api/sync/push', {
        deviceId: DEVICE_B,
        operations: [{
          entity: 'bikes', op: 'update', id: 'b-0001', force: true,
          payload: { price: 2750000 }, clientTs: pastIso(2 * H),
        }],
      });
      assert.equal(asAdmin.body.results[0].status, 'ok');
      const bike = await api(srv.base, admin.token, 'GET', '/api/bikes/b-0001');
      assert.equal(bike.body.bike.price, 2750000);
    });

    await t.test('pull : changements depuis `since`, y compris les tombstones', async () => {
      const pull1 = await api(srv.base, admin.token, 'GET', `/api/sync/pull?since=${encodeURIComponent(pastIso(4 * H))}`);
      assert.equal(pull1.status, 200);
      const ids = new Map(pull1.body.changes.map((c) => [c.id, c]));
      assert.ok(ids.has('b-0001'));
      assert.equal(ids.get('b-0001').op, 'upsert');
      assert.ok(ids.has('s-0001'));
      assert.ok(ids.get('s-0001').data.items);

      // Suppression hors ligne d\u2019un client, puis pull
      await api(srv.base, admin.token, 'POST', '/api/sync/push', {
        deviceId: DEVICE_A,
        operations: [{ entity: 'customers', op: 'delete', id: 'c-0001', clientTs: nowIso() }],
      });
      const pull2 = await api(srv.base, admin.token, 'GET', `/api/sync/pull?since=${encodeURIComponent(pastIso(10 * 60e3))}`);
      const del = pull2.body.changes.find((c) => c.id === 'c-0001');
      assert.equal(del.op, 'delete');
      assert.ok(del.data.deletedAt);
    });

    await t.test('pull : pagination par curseur sans doublons', async () => {
      // Crée 12 clients « hors ligne » pour dépasser la limite de 10
      const ops = Array.from({ length: 12 }, (_, i) => ({
        entity: 'customers', op: 'create', id: `bulk-${String(i).padStart(2, '0')}`,
        payload: { first_name: `Bulk ${i}`, last_name: 'Client', phone: `+261 34 9${String(i).padStart(7, '0')}` },
        clientTs: nowIso(),
      }));
      const push = await api(srv.base, admin.token, 'POST', '/api/sync/push', { deviceId: DEVICE_A, operations: ops });
      assert.equal(push.body.results.every((r) => r.status === 'ok'), true);

      let cursor = null;
      let seen = 0;
      const seenIds = new Set();
      for (let page = 0; page < 10; page++) {
        const url = `/api/sync/pull?since=${encodeURIComponent(pastIso(10 * 60e3))}&limit=10` +
          (cursor ? `&cursor=${cursor}` : '');
        const res = await api(srv.base, admin.token, 'GET', url);
        assert.ok(res.body.changes.length <= 10);
        for (const c of res.body.changes) {
          assert.ok(!seenIds.has(c.id), 'doublon détecté : ' + c.id);
          seenIds.add(c.id);
          seen += 1;
        }
        cursor = res.body.nextCursor;
        if (!cursor) break;
      }
      assert.ok(seen >= 12, `attendu >= 12 changements, vu ${seen}`);
    });

    await t.test('renumération des numéros de bon en cas de collision', async () => {
      // Ré-activer c-0001 (supprimé plus haut) pour la FK
      await api(srv.base, admin.token, 'POST', '/api/sync/push', {
        deviceId: DEVICE_A,
        operations: [{
          entity: 'customers', op: 'create', id: 'c-0001',
          payload: { first_name: 'Rija', last_name: 'Ando', phone: '+261 34 11 22 33' },
          clientTs: nowIso(),
        }],
      });

      // Deux ventes hors ligne proposent le même numéro de bon
      const mk = (id, num) => ({
        entity: 'sales', op: 'create', id,
        payload: {
          customer_id: 'c-0001', status: 'brouillon', sale_date: new Date().toISOString().slice(0, 10),
          items: [{ bike_id: 'b-0001', unit_price: 1000000, quantity: 1 }],
          sale_number: num,
        },
        clientTs: nowIso(),
      });
      const res = await api(srv.base, admin.token, 'POST', '/api/sync/push', {
        deviceId: DEVICE_A,
        operations: [mk('s-1001', 'BC-2026-9999'), mk('s-1002', 'BC-2026-9999')],
      });
      assert.equal(res.body.results[0].status, 'ok');
      assert.equal(res.body.results[1].status, 'ok');
      const n1 = res.body.results[0].saleNumber;
      const n2 = res.body.results[1].saleNumber;
      assert.equal(n1, 'BC-2026-9999');
      assert.notEqual(n1, n2);
      assert.ok(/^BC-\d{4}-\d{4}$/.test(n2), 'numéro ré-affecté inattendu : ' + n2);
    });

    await t.test('une mise à jour ne change pas le numéro de bon', async () => {
      // Régression : l'allocation du numéro s'exécutait aussi sur les `update`,
      // si bien que chaque modification d'une vente lui attribuait un nouveau
      // BC-AAAA-NNNN (et libérait l'ancien numéro pour une autre vente).
      const id = 's-2001';
      const created = await api(srv.base, admin.token, 'POST', '/api/sync/push', {
        deviceId: DEVICE_A,
        operations: [{
          entity: 'sales', op: 'create', id,
          payload: {
            customer_id: 'c-0001', status: 'brouillon',
            sale_date: new Date().toISOString().slice(0, 10),
            items: [{ bike_id: 'b-0001', unit_price: 500000, quantity: 1 }],
          },
          clientTs: nowIso(),
        }],
      });
      assert.equal(created.body.results[0].status, 'ok');
      const original = created.body.results[0].saleNumber;
      assert.ok(/^BC-\d{4}-\d{4}$/.test(original), 'numéro initial inattendu : ' + original);

      // Trois modifications successives : le numéro doit rester stable.
      for (const payload of [{ status: 'confirme' }, { discount: 50000 }, { amount_paid: 200000 }]) {
        const upd = await api(srv.base, admin.token, 'POST', '/api/sync/push', {
          deviceId: DEVICE_A,
          operations: [{ entity: 'sales', op: 'update', id, payload, clientTs: nowIso() }],
        });
        assert.equal(upd.body.results[0].status, 'ok');
        assert.equal(upd.body.results[0].saleNumber, original,
          `numéro modifié après ${JSON.stringify(payload)} : ${upd.body.results[0].saleNumber}`);
      }

      const after = await api(srv.base, admin.token, 'GET', `/api/sales/${id}`);
      assert.equal(after.status, 200);
      assert.equal(after.body.sale.sale_number, original);
      // Les effets de domaine et le recalcul du paiement restent appliqués.
      assert.equal(after.body.sale.status, 'confirme');
      assert.equal(after.body.sale.discount, 50000);
      assert.equal(after.body.sale.amount_paid, 200000);
      assert.equal(after.body.sale.payment_status, 'partial');
    });

    await t.test('santé et statut', async () => {
      const h = await api(srv.base, null, 'GET', '/api/health');
      assert.equal(h.body.ok, true);
      const s = await api(srv.base, admin.token, 'GET', '/api/sync/status');
      assert.ok(s.body.counts.bikes >= 1);
    });
  } finally {
    await srv.close();
  }
});
