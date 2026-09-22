'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

/** Crée les comptes de démonstration (admin + vendeur). Renvoie leurs ids. */
function seedUsers(db) {
  const ts = now();
  const insertUser = db.prepare(
    'INSERT INTO users (id, username, password_hash, full_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const adminId = uuid();
  const sellerId = uuid();
  insertUser.run(adminId, 'admin', bcrypt.hashSync('admin123', 10), 'Fana Rakoto (Admin)', 'admin', ts, ts);
  insertUser.run(sellerId, 'vendeur', bcrypt.hashSync('vendeur123', 10), 'Hery Andrianja (Vendeur)', 'seller', ts, ts);
  return { adminId, sellerId };
}

/**
 * Sème les données de démo si la base est vide.
 * @param {object} [opts]
 * @param {boolean} [opts.usersOnly=false] ne créer que les comptes utilisateurs.
 */
function seedIfEmpty(db, { usersOnly = false } = {}) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) return false;
  const { adminId } = seedUsers(db);
  if (usersOnly) return true;

  const ts = now();
  const insertBike = db.prepare(`
    INSERT INTO bikes (id, brand, model, year, mileage_km, engine_cc, color, serial_number, price,
      currency, mechanical_state, aesthetic_state, status, description, warehouse, photos,
      created_at, updated_at, version, created_by, owner_id, device_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'MGA', ?, ?, ?, ?, 'Magasin Antananarivo', '[]', ?, ?, 1, 'seed', ?, 'seed')
  `);

  const bikes = [
    ['Yamaha', 'XT 125 Z', 2021, 18450, 125, 'Noir', 'YAM-2021-48211', 2850000, 4, 4, 'available', 'Trail 125 cc, très bon entretien, pneus neufs.'],
    ['Honda', 'CB 125F Dream', 2019, 32100, 125, 'Bleu', 'HON-2019-11207', 2350000, 4, 3, 'available', 'Moto de route fiable, révisée à 30 000 km.'],
    ['Suzuki', 'GSR 125', 2022, 9800, 125, 'Rouge', 'SUZ-2022-00534', 3400000, 5, 4, 'sold', 'Sportive 125 cc — vendue (voir bon BC-0001).'],
    ['Peugeot', 'Django 50', 2020, 21300, 50, 'Blanc', 'PEU-2020-77120', 1950000, 3, 4, 'reserved', 'Scooter 50 4T, très esthétique, papiers à jour.'],
    ['Yamaha', 'YBR 125', 2018, 41200, 125, 'Gris', 'YAM-2018-90312', 1800000, 3, 3, 'sold', 'Enduro urbaine — vendue (voir bon BC-0003).'],
    ['Honda', 'PCX 125', 2021, 15700, 125, 'Noir', 'HON-2021-33419', 3950000, 4, 5, 'sold', 'Scooter 125 premium — vendu (voir bon BC-0002).'],
    ['Suzuki', 'GN 125', 2017, 54800, 125, 'Bleu foncé', 'SUZ-2017-55871', 1550000, 3, 2, 'maintenance', 'Moto de travail, à contrôler (freins).'],
    ['Derbi', 'GPR 50', 2019, 27600, 50, 'Jaune', 'DER-2019-20455', 2100000, 3, 4, 'available', 'Scooter 50 4T performant, idéal ville.'],
    ['Yamaha', 'FZ 25', 2016, 68900, 25, 'Rouge', 'YAM-2016-10229', 1250000, 2, 3, 'sold', 'Cub 2T vendue — conservée pour historique.'],
    ['Honda', 'Wave 110i', 2023, 63000, 110, 'Orange', 'HON-2023-41276', 2700000, 5, 5, 'available', 'Cub 110 4T, garantie constructeur restante.'],
    ['Yamaha', 'TMAX 530', 2020, 24500, 280, 'Gris', 'YAM-2020-77810', 5200000, 4, 4, 'available', 'Scooter 280 premium, entretien Yamaha complet.'],
  ];
  for (const b of bikes) insertBike.run(uuid(), ...b, ts, ts, adminId);

  const insertCustomer = db.prepare(`
    INSERT INTO customers (id, first_name, last_name, phone, email, address, notes, created_at, updated_at, version, created_by, owner_id, device_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'seed', ?, 'seed')
  `);
  const customers = [
    ['Rakoto', 'Jean', '+261 34 01 234 56', 'rakoto.jean@example.mg', 'Antananarivo, Analakely', 'Client fidèle, 2 achats précédents.'],
    ['Miaraka', 'Lova', '+261 33 09 887 76', null, 'Toamasina', 'Préfére le paiement à l\u2019avance.'],
    ['Andria', 'Fetra', '+261 32 11 223 34', 'fetra.andria@example.mg', 'Antsirabe', null],
    ['Rasoa', 'Mamy', '+261 34 45 566 77', null, 'Antananarivo, Ivandry', 'Vendeur ambulants — remise possible.'],
    ['Ranaivo', 'Tahiry', '+261 37 90 112 23', 'tahiry.r@example.mg', 'Mahajanga', null],
  ];
  const customerIds = customers.map((c) => {
    const id = uuid();
    insertCustomer.run(id, ...c, ts, ts, adminId);
    return id;
  });

  const bikeIds = db.prepare('SELECT id FROM bikes ORDER BY rowid').all().map((r) => r.id);

  const insertSale = db.prepare(`
    INSERT INTO sales (id, sale_number, customer_id, total, discount, amount_paid, payment_method,
      payment_status, status, sale_date, notes, created_at, updated_at, version, created_by, owner_id, device_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'seed', ?, 'seed')
  `);
  const insertItem = db.prepare(
    'INSERT INTO sale_items (id, sale_id, bike_id, unit_price, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  const y = new Date().getFullYear();
  const saleA = uuid();
  insertSale.run(saleA, `BC-${y}-0001`, customerIds[0], 2850000, 50000, 2800000, 'cash', 'paid',
    'livre', '2026-06-12', 'Livraison Antananarivo.', ts, ts, adminId);
  insertItem.run(uuid(), saleA, bikeIds[2], 2900000, 1, ts, ts);
  // total = 2 900 000 - 50 000 = 2 850 000

  const saleB = uuid();
  insertSale.run(saleB, `BC-${y}-0002`, customerIds[1], 3950000, 0, 1000000, 'transfer', 'partial',
    'confirme', '2026-08-28', 'Solde attendu fin septembre.', ts, ts, adminId);
  insertItem.run(uuid(), saleB, bikeIds[5], 3950000, 1, ts, ts);

  const saleC = uuid();
  insertSale.run(saleC, `BC-${y}-0003`, customerIds[2], 1800000, 100000, 1700000, 'cash', 'paid',
    'confirme', '2026-09-02', null, ts, ts, adminId);
  insertItem.run(uuid(), saleC, bikeIds[4], 1900000, 1, ts, ts);

  db.prepare('INSERT INTO sale_counters (year, last) VALUES (?, 3)').run(y);

  return true;
}

module.exports = { seedIfEmpty, seedUsers };
