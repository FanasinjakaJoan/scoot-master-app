'use strict';

/**
 * Isolation des données utilisateur (Row-Level Security) & privilèges admin.
 *
 * Vérifie que :
 *  - chaque utilisateur régulier (vendeur) ne lit, modifie et supprime QUE ses
 *    propres données, sur les routes REST comme sur le moteur de synchronisation ;
 *  - une donnée d'autrui est invisible (404) et non modifiable (403/erreur) ;
 *  - un admin contourne l'isolation et accède à l'intégralité des données ;
 *  - la propriété est toujours forcée par le serveur (jamais reprise du client).
 */

const test = require('node:test');
const assert = require('node:assert');
const { startTestServer, login, api } = require('./helpers');

/** Crée un second vendeur pour croiser les périmètres. */
async function createSeller(base, adminToken, username) {
  const created = await api(base, adminToken, 'POST', '/api/users', {
    username, password: 'motdepasse1', fullName: `Vendeur ${username}`, role: 'seller',
  });
  assert.equal(created.status, 201);
  const { token } = await login(base, username, 'motdepasse1');
  return { id: created.body.user.id, token };
}

test('RLS : isolation par utilisateur et contournement admin', async (t) => {
  // Base vide (comptes seulement) : chaque vendeur crée ses propres données.
  const srv = await startTestServer({ seed: 'users' });
  const admin = await login(srv.base);
  const alice = await createSeller(srv.base, admin.token, 'alice');
  const bob = await createSeller(srv.base, admin.token, 'bob');
  try {
    await t.test('création : la propriété est forcée à l\u2019utilisateur authentifié', async () => {
      const bike = await api(srv.base, alice.token, 'POST', '/api/bikes', {
        brand: 'Yamaha', model: 'XT 125', price: 2500000,
      });
      assert.equal(bike.status, 201);
      // La valeur `owner_id` fournie par le client est ignorée (pas d'usurpation).
      const spoof = await api(srv.base, alice.token, 'POST', '/api/bikes', {
        brand: 'Honda', model: 'CB 125', price: 2000000, owner_id: bob.id,
      });
      assert.equal(spoof.status, 201);
      const row = srv.db.prepare('SELECT owner_id FROM bikes WHERE id = ?').get(bike.body.bike.id);
      assert.equal(row.owner_id, alice.id);
      assert.equal(spoof.body.bike.owner_id, alice.id, 'owner_id client ignoré pour un vendeur');
    });

    await t.test('lecture : un vendeur ne voit que ses lignes, l\u2019admin voit tout', async () => {
      const aliceList = await api(srv.base, alice.token, 'GET', '/api/bikes');
      assert.equal(aliceList.body.total, 2);

      const bobList = await api(srv.base, bob.token, 'GET', '/api/bikes');
      assert.equal(bobList.body.total, 0, 'bob ne doit voir aucune moto d\u2019alice');

      const adminList = await api(srv.base, admin.token, 'GET', '/api/bikes');
      assert.equal(adminList.body.total, 2, 'l\u2019admin voit les données de tous');
    });

    await t.test('fiche détaillée : 404 pour un tiers, 200 pour le propriétaire et l\u2019admin', async () => {
      const aliceBike = (await api(srv.base, alice.token, 'GET', '/api/bikes')).body.items[0];
      assert.equal((await api(srv.base, alice.token, 'GET', `/api/bikes/${aliceBike.id}`)).status, 200);
      assert.equal((await api(srv.base, bob.token, 'GET', `/api/bikes/${aliceBike.id}`)).status, 404);
      assert.equal((await api(srv.base, admin.token, 'GET', `/api/bikes/${aliceBike.id}`)).status, 200);
    });

    await t.test('modification : refusée pour un tiers, autorisée pour l\u2019admin', async () => {
      const aliceBike = (await api(srv.base, alice.token, 'GET', '/api/bikes')).body.items[0];
      const denied = await api(srv.base, bob.token, 'PUT', `/api/bikes/${aliceBike.id}`, { price: 1 });
      assert.equal(denied.status, 404);
      // la valeur n'a pas bougé
      assert.equal((await api(srv.base, admin.token, 'GET', `/api/bikes/${aliceBike.id}`)).body.bike.price,
        aliceBike.price);

      const byAdmin = await api(srv.base, admin.token, 'PUT', `/api/bikes/${aliceBike.id}`, { price: 1234567 });
      assert.equal(byAdmin.status, 200);
      assert.equal(byAdmin.body.bike.price, 1234567);
    });

    await t.test('clients & ventes : isolation croisée et vente du stock d\u2019autrui refusée', async () => {
      const carol = await createSeller(srv.base, admin.token, 'carol');
      // Alice crée un client et une moto
      const aliceBike = (await api(srv.base, alice.token, 'GET', '/api/bikes')).body.items[0];
      const aliceCustomer = await api(srv.base, alice.token, 'POST', '/api/customers', {
        first_name: 'Client', last_name: 'Alice', phone: '+261 34 00 00 01',
      });
      assert.equal(aliceCustomer.status, 201);

      // Bob ne voit ni le client ni la moto d'Alice
      assert.equal((await api(srv.base, bob.token, 'GET', '/api/customers')).body.total, 0);
      assert.equal((await api(srv.base, bob.token, 'GET', `/api/customers/${aliceCustomer.body.customer.id}`)).status, 404);

      // Bob ne peut PAS vendre la moto d'Alice sur son propre client
      const bobCustomer = await api(srv.base, bob.token, 'POST', '/api/customers', {
        first_name: 'Client', last_name: 'Bob', phone: '+261 34 00 00 02',
      });
      const crossSale = await api(srv.base, bob.token, 'POST', '/api/sales', {
        customer_id: bobCustomer.body.customer.id,
        items: [{ bike_id: aliceBike.id, unit_price: 100, quantity: 1 }],
      });
      assert.equal(crossSale.status, 400, 'vendre le stock d\u2019autrui doit échouer');

      // Bob ne peut pas non plus facturer le client d'Alice
      const crossSale2 = await api(srv.base, bob.token, 'POST', '/api/sales', {
        customer_id: aliceCustomer.body.customer.id,
        items: [{ bike_id: 'x', unit_price: 100, quantity: 1 }],
      });
      assert.equal(crossSale2.status, 400);

      // L'admin, lui, peut vendre n'importe quoi à n'importe qui
      const adminSale = await api(srv.base, admin.token, 'POST', '/api/sales', {
        customer_id: aliceCustomer.body.customer.id,
        items: [{ bike_id: aliceBike.id, unit_price: 100, quantity: 1 }],
      });
      assert.equal(adminSale.status, 201);
      // carol ne voit toujours rien
      assert.equal((await api(srv.base, carol.token, 'GET', '/api/sales')).body.total, 0);
    });

    await t.test('exports & sauvegarde : périmètre utilisateur, admin = tout', async () => {
      const aliceCsv = await fetch(srv.base + '/api/exports/bikes?format=csv', {
        headers: { Authorization: 'Bearer ' + alice.token },
      });
      assert.equal(aliceCsv.status, 200);
      const aliceRows = await (await fetch(srv.base + '/api/exports/bikes', {
        headers: { Authorization: 'Bearer ' + alice.token },
      })).json();
      assert.ok(aliceRows.rows.length >= 1);
      assert.ok(aliceRows.rows.every((r) => r.owner_id === alice.id));

      const bobRows = await (await fetch(srv.base + '/api/exports/bikes', {
        headers: { Authorization: 'Bearer ' + bob.token },
      })).json();
      assert.equal(bobRows.rows.length, 0);

      const adminBackup = await (await fetch(srv.base + '/api/exports/backup', {
        headers: { Authorization: 'Bearer ' + admin.token },
      })).json();
      assert.ok(adminBackup.bikes.length >= 2);

      const bobBackup = await (await fetch(srv.base + '/api/exports/backup', {
        headers: { Authorization: 'Bearer ' + bob.token },
      })).json();
      assert.equal(bobBackup.bikes.length, 0);
    });

    await t.test('compteurs de sync : portée utilisateur', async () => {
      const aliceStatus = await api(srv.base, alice.token, 'GET', '/api/sync/status');
      assert.equal(aliceStatus.body.counts.bikes, 2);
      const bobStatus = await api(srv.base, bob.token, 'GET', '/api/sync/status');
      assert.equal(bobStatus.body.counts.bikes, 0);
      const adminStatus = await api(srv.base, admin.token, 'GET', '/api/sync/status');
      assert.equal(adminStatus.body.counts.bikes, 2);
    });

    await t.test('pull : un vendeur ne reçoit que ses changements', async () => {
      const since = encodeURIComponent('1970-01-01T00:00:00.000Z');
      const alice = await login(srv.base, 'alice', 'motdepasse1');
      const bob = await login(srv.base, 'bob', 'motdepasse1');
      const alicePull = await api(srv.base, alice.token, 'GET', `/api/sync/pull?since=${since}`);
      const bobPull = await api(srv.base, bob.token, 'GET', `/api/sync/pull?since=${since}`);
      const adminPull = await api(srv.base, admin.token, 'GET', `/api/sync/pull?since=${since}`);
      assert.ok(alicePull.body.changes.length > 0);
      assert.ok(alicePull.body.changes.every((c) => c.entity !== 'bikes' || c.data.owner_id === alice.user.id));
      // bob ne reçoit que ses propres lignes (il a créé un client plus haut),
      // jamais celles d'alice.
      assert.ok(bobPull.body.changes.every((c) => c.data.owner_id === bob.user.id || !c.data.owner_id));
      assert.ok(!bobPull.body.changes.some((c) => c.data.owner_id === alice.user.id));
      assert.ok(adminPull.body.changes.length >= alicePull.body.changes.length);
    });

    await t.test('journal d\u2019audit : réservé admin, trace les actions sensibles', async () => {
      const admin = await login(srv.base);
      // Action d'alice (création de moto) tracée.
      await api(srv.base, alice.token, 'POST', '/api/bikes', { brand: 'Kawasaki', model: 'KLR', price: 3000000 });

      const forbidden = await api(srv.base, alice.token, 'GET', '/api/exports/audit');
      assert.equal(forbidden.status, 403);

      const audit = await api(srv.base, admin.token, 'GET', '/api/exports/audit?entity=bikes');
      assert.equal(audit.status, 200);
      assert.ok(audit.body.items.length > 0);
      const create = audit.body.items.find((e) => e.action === 'bike.create');
      assert.ok(create, 'la création de moto est journalisée');
      assert.equal(create.actor_id, alice.id);
      assert.equal(create.actor_role, 'seller');
      assert.equal(create.admin_access, false, 'un vendeur ne bénéficie pas de l\u2019accès admin');

      // La suppression admin est marquée admin_access.
      const someBike = (await api(srv.base, admin.token, 'GET', '/api/bikes')).body.items[0];
      await api(srv.base, admin.token, 'DELETE', `/api/bikes/${someBike.id}`);
      const after = await api(srv.base, admin.token, 'GET', '/api/exports/audit?action=bike.delete');
      assert.equal(after.body.items[0].admin_access, true);
    });

    await t.test('suppression : un vendeur ne peut pas supprimer (403 admin requis)', async () => {
      const aliceBike = (await api(srv.base, alice.token, 'GET', '/api/bikes')).body.items[0];
      const denied = await api(srv.base, alice.token, 'DELETE', `/api/bikes/${aliceBike.id}`);
      assert.equal(denied.status, 403);
      const ok = await api(srv.base, admin.token, 'DELETE', `/api/bikes/${aliceBike.id}`);
      assert.equal(ok.status, 200);
    });
  } finally {
    await srv.close();
  }
});
