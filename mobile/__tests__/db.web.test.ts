/**
 * Adaptateur SQLite web (`db.web.ts`) — c'est lui qui remet l'application sur
 * pied dans le navigateur (l'ouverture synchrone d'`expo-sqlite` y était
 * impossible). Les tests portent donc sur les capacités réellement utilisées
 * par l'app : schéma, liaisons de paramètres, LIKE/agrégats, upsert,
 * transactions (annulation + imbrication) et persistance absente tolérée.
 */

// Le bundle web charge le moteur via l'asset Metro `.wasm` (une URL) ; sous Jest
// on fournit directement le chemin du fichier sur disque.
jest.mock('sql.js/dist/sql-wasm.wasm', () => require.resolve('sql.js/dist/sql-wasm.wasm'), {
  virtual: true,
});

// Les modules qui importent './db' doivent recevoir l'implémentation web.
jest.mock('../src/data/local/db', () => jest.requireActual('../src/data/local/db.web'));

// Le module web n'est résolu par Metro que sur la cible web : sous Jest on le
// charge explicitement (mêmes exports que `db.ts`, implémentation différente).
type DbModule = typeof import('../src/data/local/db.web');
type ReposModule = typeof import('../src/data/local/repositories');

const { initLocalDb, localDb, flushLocalDb } = jest.requireActual('../src/data/local/db.web') as DbModule;
const repo = jest.requireActual('../src/data/local/repositories') as ReposModule;

const TABLES = ['bikes', 'customers', 'sales', 'sale_items', 'sync_queue', 'sync_conflicts', 'sync_meta'];

beforeAll(async () => {
  await initLocalDb();
  await initLocalDb(); // idempotent (deuxièmement appelé par App.tsx + effets)
});

beforeEach(() => {
  for (const table of TABLES) localDb.runSync(`DELETE FROM ${table}`);
});

const actor = { userId: 'user-1', deviceId: 'dev-test' };

describe('initialisation', () => {
  it('crée toutes les tables métier et de synchronisation', () => {
    const rows = localDb.getAllSync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    );
    const names = rows.map((r) => String(r.name));
    for (const table of TABLES) expect(names).toContain(table);
  });

  it('expose les mêmes utilitaires que le module natif', () => {
    const db = jest.requireActual('../src/data/local/db.web') as DbModule;
    expect(typeof db.SCHEMA).toBe('string');
    expect(typeof db.nowIso()).toBe('string');
  });
});

describe('lecture / écriture SQL', () => {
  it('insère, relit et normalise les colonnes', () => {
    localDb.runSync(
      'INSERT INTO bikes (id, brand, model, price, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      'b1', 'Honda', 'Wave 110i', 1500000, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    const bike = localDb.getFirstSync<Record<string, unknown>>('SELECT * FROM bikes WHERE id = ?', 'b1');
    expect(bike?.brand).toBe('Honda');
    expect(Number(bike?.price)).toBe(1500000);
    // Colonnes absentes de l'INSERT : valeurs par défaut du schéma, pas undefined.
    expect(String(bike?.currency)).toBe('MGA');
    expect(String(bike?.photos)).toBe('[]');
    expect(bike?.deleted_at).toBeNull();
  });

  it('accepte les booléens et objets en paramètre lié', () => {
    expect(() =>
      localDb.runSync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', 'a', { ok: true })
    ).not.toThrow();
    expect(String(localDb.getFirstSync<{ value: unknown }>('SELECT value FROM sync_meta WHERE key = ?', 'a')?.value))
      .toBe('{"ok":true}');
  });

  it('recherche avec LIKE et trie (catalogue)', () => {
    repo.saveBike({ id: 'b1', brand: 'Yamaha', model: 'YBR 125', price: 900000, mileage_km: 12000 }, actor);
    repo.saveBike({ id: 'b2', brand: 'Honda', model: 'Wave 110i', price: 1500000, mileage_km: 4000 }, actor);
    expect(repo.listBikes({ q: 'wave' }).map((b) => b.id)).toEqual(['b2']);
    expect(repo.listBikes({ sort: 'price', order: 'asc' }).map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(repo.listBikes({ sort: 'price', order: 'desc' }).map((b) => b.id)).toEqual(['b2', 'b1']);
    expect(repo.listBikes({ brand: 'Honda', status: 'available' }).map((b) => b.id)).toEqual(['b2']);
    expect(repo.availableBrands()).toEqual(['Honda', 'Yamaha']);
  });

  it('applique les agrégats du tableau de bord', () => {
    repo.saveBike({ id: 'b1', brand: 'Honda', model: 'CBF', price: 1000000 }, actor);
    const stats = repo.dashboardStats();
    expect(stats.availableBikes).toBe(1);
    expect(stats.stockValue).toBe(1000000);
  });
});

describe('upsert et file de synchronisation', () => {
  it('insère puis met à jour sur conflit de clé (meta)', () => {
    repo.metaSet('device_id', 'dev-a');
    repo.metaSet('device_id', 'dev-b');
    expect(repo.metaGet('device_id')).toBe('dev-b');
    expect(localDb.getFirstSync<{ n: unknown }>('SELECT COUNT(*) AS n FROM sync_meta WHERE key = ?', 'device_id')?.n)
      .toBe(1);
  });

  it('enfile une opération par mutation locale, dans la même transaction', () => {
    repo.saveBike({ id: 'b1', brand: 'Honda', model: 'CBF', price: 1000000 }, actor);
    const ops = repo.pendingOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ entity: 'bikes', op: 'create', entity_id: 'b1', status: 'pending' });
    expect(ops[0].payload).toMatchObject({ brand: 'Honda', price: 1000000 });
    expect(Array.isArray(ops[0].payload.photos)).toBe(true);
  });

  it('numérote localement les bons de commande', () => {
    repo.saveCustomer({ id: 'c1', first_name: 'Rina', last_name: 'Hery', phone: '0340000000' }, actor);
    const sale = repo.saveSale(
      { id: 's1', customer_id: 'c1', items: [{ bike_id: 'absent', unit_price: 500000, quantity: 2 }], status: 'brouillon' },
      actor
    );
    expect(sale.sale_number).toMatch(new RegExp(`^BC-${new Date().getFullYear()}-0001$`));
    expect(sale.total).toBe(1000000);
    expect(sale.payment_status).toBe('unpaid');
    // Le compteur local est incrémenté (clé `sync_meta`), comme sur l'appareil natif.
    const next = repo.saveSale(
      { id: 's2', customer_id: 'c1', items: [], amount_paid: 100, status: 'brouillon' },
      actor
    );
    expect(next.sale_number).toMatch(new RegExp(`^BC-${new Date().getFullYear()}-0002$`));
  });
});

describe('transactions', () => {
  it('annule tout en cas d’erreur', () => {
    expect(() =>
      localDb.withTransactionSync(() => {
        localDb.runSync('INSERT INTO bikes (id, brand, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          'boom', 'Honda', 'CBF', '2026-01-01', '2026-01-01');
        throw new Error('échec volontaire');
      })
    ).toThrow('échec volontaire');
    expect(localDb.getFirstSync('SELECT id FROM bikes WHERE id = ?', 'boom')).toBeNull();
  });

  it('supporte l’imbrication via SAVEPOINT', () => {
    localDb.withTransactionSync(() => {
      localDb.runSync('INSERT INTO bikes (id, brand, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        'outer', 'Honda', 'CBF', '2026-01-01', '2026-01-01');
      localDb.withTransactionSync(() => {
        localDb.runSync('INSERT INTO bikes (id, brand, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          'inner', 'Yamaha', 'YBR', '2026-01-01', '2026-01-01');
      });
      expect(localDb.isInTransactionSync()).toBe(true);
    });
    expect(localDb.isInTransactionSync()).toBe(false);
    expect(localDb.getAllSync('SELECT id FROM bikes')).toHaveLength(2);
  });

  it('conserve la transaction extérieure quand une imbrication échoue', () => {
    expect(() =>
      localDb.withTransactionSync(() => {
        localDb.runSync('INSERT INTO bikes (id, brand, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          'keep', 'Honda', 'CBF', '2026-01-01', '2026-01-01');
        try {
          localDb.withTransactionSync(() => {
            localDb.runSync('INSERT INTO bikes (id, brand, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
              'drop', 'Yamaha', 'YBR', '2026-01-01', '2026-01-01');
            throw new Error('échec interne');
          });
        } catch {
          /* le point de sauvegarde annule seulement l'imbrication */
        }
      })
    ).not.toThrow();
    const ids = localDb.getAllSync<{ id: unknown }>('SELECT id FROM bikes').map((r) => String(r.id));
    expect(ids).toEqual(['keep']);
  });

  it('refuse un exec avant initialisation (garde-fou explicite)', () => {
    const fresh = Object.create(Object.getPrototypeOf(localDb));
    expect(() => fresh.getAllSync('SELECT 1')).toThrow(/non initialisée/i);
  });
});

describe('persistance', () => {
  it('flush() est tolérant quand aucun stockage n’est disponible (Jest/node)', async () => {
    await expect(flushLocalDb()).resolves.toBeUndefined();
  });
});
