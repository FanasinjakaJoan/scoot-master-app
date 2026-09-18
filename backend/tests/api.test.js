'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startTestServer, login, api } = require('./helpers');

test('API : catalogue, clients, ventes, exports', async (t) => {
  const srv = await startTestServer();
  const { token } = await login(srv.base);
  try {
    await t.test('catalogue : liste + filtres + tri', async () => {
      const all = await api(srv.base, token, 'GET', '/api/bikes?limit=100');
      assert.equal(all.status, 200);
      assert.ok(all.body.total >= 8);

      const filtered = await api(srv.base, token, 'GET', '/api/bikes?brand=Yamaha&status=available&sort=price&order=asc');
      assert.ok(filtered.body.items.length >= 2);
      for (const b of filtered.body.items) {
        assert.equal(b.brand, 'Yamaha');
        assert.equal(b.status, 'available');
      }
      const prices = filtered.body.items.map((b) => b.price);
      assert.deepEqual(prices, [...prices].sort((a, b) => a - b));

      const q = await api(srv.base, token, 'GET', '/api/bikes?q=trail');
      assert.ok(q.body.items.length >= 1);
    });

    await t.test('CRUD moto', async () => {
      const created = await api(srv.base, token, 'POST', '/api/bikes', {
        brand: 'Kawasaki', model: 'KX 125', year: 2022, mileage_km: 5000, engine_cc: 125,
        price: 3100000, mechanical_state: 4, aesthetic_state: 4, status: 'available',
        description: 'Moto de test', photos: ['local://photo1.jpg'],
      });
      assert.equal(created.status, 201);
      const id = created.body.bike.id;
      assert.deepEqual(created.body.bike.photos, ['local://photo1.jpg']);

      const updated = await api(srv.base, token, 'PUT', `/api/bikes/${id}`, { price: 3050000, status: 'reserved' });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.bike.price, 3050000);
      assert.equal(updated.body.bike.status, 'reserved');
      assert.equal(updated.body.bike.version, 2);
    });

    await t.test('validation des champs', async () => {
      const bad = await api(srv.base, token, 'POST', '/api/bikes', { model: 'Sans marque' });
      assert.equal(bad.status, 400);
      const badPrice = await api(srv.base, token, 'POST', '/api/bikes', { brand: 'X', model: 'Y', price: -5 });
      assert.equal(badPrice.status, 400);
    });

    await t.test('client : création + historique', async () => {
      const c = await api(srv.base, token, 'POST', '/api/customers', {
        first_name: 'Test', last_name: 'Client', phone: '+261 34 00 00 00',
      });
      assert.equal(c.status, 201);
      const cid = c.body.customer.id;

      const list = await api(srv.base, token, 'GET', '/api/customers?q=Test');
      assert.equal(list.body.total, 1);
      assert.equal(list.body.items[0].nb_sales, 0);

      const hist = await api(srv.base, token, 'GET', `/api/customers/${cid}/purchases`);
      assert.equal(hist.status, 200);
      assert.deepEqual(hist.body.sales, []);
    });

    await t.test('vente : création avec lignes, recalcul du total, statut moto', async () => {
      const bikes = await api(srv.base, token, 'GET', '/api/bikes?status=available&limit=50');
      const bike = bikes.body.items[0];
      const customers = await api(srv.base, token, 'GET', '/api/customers');
      const customer = customers.body.items[0];

      const sale = await api(srv.base, token, 'POST', '/api/sales', {
        customer_id: customer.id,
        items: [{ bike_id: bike.id, unit_price: bike.price, quantity: 1 }],
        discount: 100000,
        amount_paid: Math.max(0, bike.price - 100000),
        payment_method: 'cash',
        status: 'confirme',
        sale_date: new Date().toISOString().slice(0, 10),
      });
      assert.equal(sale.status, 201);
      assert.equal(sale.body.sale.sale_number.startsWith('BC-'), true);
      assert.equal(sale.body.sale.total, bike.price - 100000);
      assert.equal(sale.body.sale.payment_status, 'paid');

      const bikeAfter = await api(srv.base, token, 'GET', `/api/bikes/${bike.id}`);
      assert.equal(bikeAfter.body.bike.status, 'sold');

      const list = await api(srv.base, token, 'GET', '/api/sales');
      assert.ok(list.body.items.length >= 1);
      const s0 = list.body.items.find((s) => s.id === sale.body.sale.id);
      assert.ok(s0.customer && s0.items.length === 1);
    });

    await t.test('vente : annulation remet la moto en stock', async () => {
      const bikes = await api(srv.base, token, 'GET', '/api/bikes?status=available&limit=50');
      const bike = bikes.body.items[0];
      const customers = await api(srv.base, token, 'GET', '/api/customers');
      const customer = customers.body.items[0];

      const sale = await api(srv.base, token, 'POST', '/api/sales', {
        customer_id: customer.id,
        items: [{ bike_id: bike.id, unit_price: bike.price, quantity: 1 }],
        status: 'confirme',
      });
      assert.equal(sale.status, 201);
      const saleId = sale.body.sale.id;

      const cancelled = await api(srv.base, token, 'PUT', `/api/sales/${saleId}`, { status: 'annule' });
      assert.equal(cancelled.status, 200);

      const bikeAfter = await api(srv.base, token, 'GET', `/api/bikes/${bike.id}`);
      assert.equal(bikeAfter.body.bike.status, 'available');
    });

    await t.test('exports JSON et CSV', async () => {
      const csv = await fetch(srv.base + '/api/exports/bikes?format=csv', {
        headers: { Authorization: 'Bearer ' + token },
      });
      assert.equal(csv.status, 200);
      assert.ok((csv.headers.get('content-type') || '').includes('text/csv'));
      const text = await csv.text();
      assert.ok(text.includes('Marque'));
      assert.ok(text.includes('Yamaha'));

      const json = await fetch(srv.base + '/api/exports/customers', {
        headers: { Authorization: 'Bearer ' + token },
      });
      assert.equal(json.status, 200);
      const body = await json.json();
      assert.ok(body.rows.length >= 5);

      const backup = await fetch(srv.base + '/api/exports/backup', {
        headers: { Authorization: 'Bearer ' + token },
      });
      const bk = await backup.json();
      assert.ok(bk.bikes.length >= 8 && bk.sales.length >= 3 && bk.customers.length >= 5);
      assert.ok(bk.sales[0].items);
    });

    await t.test('sauvegarde : téléversement puis liste (admin)', async () => {
      const uploaded = await api(srv.base, token, 'POST', '/api/exports/backup', {
        fileName: 'test-local', data: { app: 'scoot-master', version: 1, bikes: [], customers: [], sales: [] },
      });
      assert.equal(uploaded.status, 201);
      assert.ok(uploaded.body.file, 'le nom du fichier stocké doit être renvoyé');

      // GET /api/exports/backups : doit répondre 200 et lister la sauvegarde.
      // (Régression : déclarée après `/:entity`, la route était masquée et
      // renvoyait « Entité inconnue » en 404.)
      const list = await api(srv.base, token, 'GET', '/api/exports/backups');
      assert.equal(list.status, 200);
      assert.ok(Array.isArray(list.body.items));
      assert.ok(list.body.items.some((i) => i.file === uploaded.body.file),
        'la sauvegarde téléversée doit apparaître dans la liste');

      // Téléversement invalide → 400.
      const bad = await api(srv.base, token, 'POST', '/api/exports/backup', { fileName: 'x' });
      assert.equal(bad.status, 400);

      // Liste réservée au rôle admin.
      const { token: sellerToken } = await login(srv.base, 'vendeur', 'vendeur123');
      const forbidden = await api(srv.base, sellerToken, 'GET', '/api/exports/backups');
      assert.equal(forbidden.status, 403);
    });
  } finally {
    await srv.close();
  }
});
