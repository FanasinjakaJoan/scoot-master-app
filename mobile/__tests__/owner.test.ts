/**
 * Isolation des données côté client : la colonne `owner_id` (introduite pour la
 * Row-Level Security serveur) doit être persistée localement à la création, et
 * les bases locales antérieures doivent être migrées sans perte.
 *
 * Même montage que `db.web.test.ts` : moteur SQLite web réel + repositories.
 */

jest.mock('sql.js/dist/sql-wasm.wasm', () => require.resolve('sql.js/dist/sql-wasm.wasm'), {
  virtual: true,
});
jest.mock('../src/data/local/db', () => jest.requireActual('../src/data/local/db.web'));

type DbModule = typeof import('../src/data/local/db.web');
type ReposModule = typeof import('../src/data/local/repositories');
type SchemaModule = typeof import('../src/data/local/schema');

const { initLocalDb, localDb } = jest.requireActual('../src/data/local/db.web') as DbModule;
const repo = jest.requireActual('../src/data/local/repositories') as ReposModule;
const schema = jest.requireActual('../src/data/local/schema') as SchemaModule;

const TABLES = ['bikes', 'customers', 'sales', 'sale_items', 'sync_queue', 'sync_conflicts', 'sync_meta'];
const actor = { userId: 'user-alice', deviceId: 'dev-test' };

beforeAll(async () => {
  await initLocalDb();
});

beforeEach(() => {
  for (const table of TABLES) localDb.runSync(`DELETE FROM ${table}`);
});

describe('owner_id local (isolation des données)', () => {
  it('persiste le propriétaire à la création d’une moto, d’un client et d’une vente', () => {
    repo.saveBike({ id: 'b1', brand: 'Yamaha', model: 'YBR', price: 900000 }, actor);
    repo.saveCustomer({ id: 'c1', first_name: 'Rina', last_name: 'Hery', phone: '0340000000' }, actor);
    repo.saveSale(
      { id: 's1', customer_id: 'c1', items: [{ bike_id: 'b1', unit_price: 900000, quantity: 1 }], status: 'brouillon' },
      actor
    );

    const bike = localDb.getFirstSync<Record<string, unknown>>('SELECT owner_id FROM bikes WHERE id = ?', 'b1');
    const customer = localDb.getFirstSync<Record<string, unknown>>('SELECT owner_id FROM customers WHERE id = ?', 'c1');
    const sale = localDb.getFirstSync<Record<string, unknown>>('SELECT owner_id FROM sales WHERE id = ?', 's1');
    expect(bike?.owner_id).toBe('user-alice');
    expect(customer?.owner_id).toBe('user-alice');
    expect(sale?.owner_id).toBe('user-alice');
  });

  it('un changement serveur conserve le propriétaire (pull)', () => {
    repo.applyServerChange('bikes', 'b-server', 'upsert', '2026-09-22T10:00:00.000Z', {
      brand: 'Honda', model: 'CBF', price: 1000000, mileage_km: 0, mechanical_state: 3,
      aesthetic_state: 3, status: 'available', currency: 'MGA', owner_id: 'user-bob',
      updated_at: '2026-09-22T10:00:00.000Z',
    });
    const row = localDb.getFirstSync<Record<string, unknown>>('SELECT owner_id FROM bikes WHERE id = ?', 'b-server');
    expect(row?.owner_id).toBe('user-bob');
  });

  it('la sauvegarde locale embarque owner_id (restauration fidèle)', () => {
    repo.saveBike({ id: 'b1', brand: 'Yamaha', model: 'YBR', price: 900000 }, actor);
    const backup = repo.localBackup() as { bikes: Record<string, unknown>[] };
    expect(backup.bikes[0].owner_id).toBe('user-alice');
  });
});

describe('migration du schéma local', () => {
  it('est idempotente quand la colonne existe déjà', () => {
    expect(() => schema.migrateLocalSchema(localDb)).not.toThrow();
    for (const table of ['bikes', 'customers', 'sales']) {
      const cols = localDb.getAllSync<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
      expect(cols).toContain('owner_id');
    }
  });

  it('ajoute owner_id à une table historique qui en est dépourvue', () => {
    // Adaptateur factice mimant une base avant migration : `bikes` existe sans
    // `owner_id`, et l'ALTER doit être exécuté.
    const columns: Record<string, string[]> = { bikes: ['id', 'brand'], customers: ['id'], sales: ['id'] };
    const statements: string[] = [];
    const stub = {
      getAllSync: <T>(sql: string) => {
        const table = sql.match(/PRAGMA table_info\((\w+)\)/)?.[1] || '';
        return (columns[table] || []).map((name) => ({ name } as unknown as T));
      },
      runSync: (sql: string) => {
        statements.push(sql);
        const m = sql.match(/ALTER TABLE (\w+) ADD COLUMN owner_id/);
        if (m) columns[m[1]].push('owner_id');
      },
    };

    schema.migrateLocalSchema(stub);
    expect(statements).toEqual([
      'ALTER TABLE bikes ADD COLUMN owner_id TEXT',
      'ALTER TABLE customers ADD COLUMN owner_id TEXT',
      'ALTER TABLE sales ADD COLUMN owner_id TEXT',
    ]);

    // Deuxième passage : idempotent (plus aucun ALTER).
    statements.length = 0;
    schema.migrateLocalSchema(stub);
    expect(statements).toHaveLength(0);
  });
});
