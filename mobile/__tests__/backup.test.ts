/**
 * Sauvegarde & exports locaux — ce que l'écran « Synchronisation » partage
 * (`💾 Sauvegarde complète (JSON)`, exports JSON/CSV par entité).
 *
 * Même montage que `db.web.test.ts` : moteur SQLite web réel + repositories,
 * donc on teste bien le contenu produit par l'application.
 */

jest.mock('sql.js/dist/sql-wasm.wasm', () => require.resolve('sql.js/dist/sql-wasm.wasm'), {
  virtual: true,
});
jest.mock('../src/data/local/db', () => jest.requireActual('../src/data/local/db.web'));

type DbModule = typeof import('../src/data/local/db.web');
type ReposModule = typeof import('../src/data/local/repositories');
type EngineModule = typeof import('../src/data/sync/engine');

const { initLocalDb, localDb } = jest.requireActual('../src/data/local/db.web') as DbModule;
const repo = jest.requireActual('../src/data/local/repositories') as ReposModule;
const engine = jest.requireActual('../src/data/sync/engine') as EngineModule;

const TABLES = ['bikes', 'customers', 'sales', 'sale_items', 'sync_queue', 'sync_conflicts', 'sync_meta'];
const actor = { userId: 'user-1', deviceId: 'dev-test' };

beforeAll(async () => {
  await initLocalDb();
});

beforeEach(() => {
  for (const table of TABLES) localDb.runSync(`DELETE FROM ${table}`);
});

describe('sauvegarde complète (localBackupSpec)', () => {
  it('contient toutes les entités et les lignes de vente', () => {
    repo.saveBike({ id: 'b1', brand: 'Yamaha', model: 'YBR 125', price: 900000 }, actor);
    repo.saveCustomer({ id: 'c1', first_name: 'Rina', last_name: 'Hery', phone: '0340000000' }, actor);
    repo.saveSale(
      { id: 's1', customer_id: 'c1', items: [{ bike_id: 'b1', unit_price: 900000, quantity: 1 }], status: 'brouillon' },
      actor
    );

    const spec = engine.localBackupSpec();
    expect(spec.mime).toBe('application/json');
    expect(spec.fileName).toMatch(/^scoot-backup-\d{4}-\d{2}-\d{2}T[\d-]+\.json$/);

    const backup = JSON.parse(spec.content);
    expect(backup.app).toBe('scoot-master');
    expect(backup.version).toBe(1);
    expect(backup.exportedAt).toBeTruthy();
    expect(backup.bikes).toHaveLength(1);
    expect(backup.customers).toHaveLength(1);
    expect(backup.sales).toHaveLength(1);
    expect(backup.sales[0].items).toHaveLength(1);
    expect(backup.sales[0].items[0].unit_price).toBe(900000);
  });

  it('emporte les colonnes de synchronisation (restore + arbitrage LWW possibles)', () => {
    repo.saveBike({ id: 'b1', brand: 'Honda', model: 'CBF', price: 1000000 }, actor);
    const [bike] = JSON.parse(engine.localBackupSpec().content).bikes;
    expect(bike.id).toBe('b1');
    expect(bike.updated_at).toBeTruthy();
    expect(bike.created_at).toBeTruthy();
    expect(typeof bike.version).toBe('number');
    expect(bike).toHaveProperty('device_id');
  });

  it('conserve les suppressions logiques (tombstones)', () => {
    repo.saveBike({ id: 'b1', brand: 'Honda', model: 'CBF', price: 1000000 }, actor);
    repo.deleteBike('b1', actor);
    const backup = JSON.parse(engine.localBackupSpec().content);
    expect(backup.bikes).toHaveLength(1);
    expect(backup.bikes[0].deleted_at).toBeTruthy();
  });

  it('reste exploitable base vide (aucune entité)', () => {
    const backup = JSON.parse(engine.localBackupSpec().content);
    expect(backup).toMatchObject({ bikes: [], customers: [], sales: [] });
  });
});

describe('exports par entité (exportLocal)', () => {
  beforeEach(() => {
    repo.saveBike({ id: 'b1', brand: 'Yamaha', model: 'YBR 125', price: 900000, status: 'available' }, actor);
    repo.saveCustomer({ id: 'c1', first_name: 'Rina', last_name: 'Hery', phone: '0340000000' }, actor);
  });

  it('CSV motos : en-têtes français + valeurs', () => {
    const spec = engine.exportLocal('bikes', 'csv');
    expect(spec.mime).toBe('text/csv');
    expect(spec.fileName).toMatch(/^scoot-bikes-[\d-T]+\.csv$/);
    const [header] = spec.content.trim().split('\n');
    expect(header).toContain('Marque');
    expect(header).toContain('Prix (Ar)');
    expect(spec.content).toContain('Yamaha');
    expect(spec.content).toContain('900000');
  });

  it('CSV clients : une ligne par client', () => {
    const spec = engine.exportLocal('customers', 'csv');
    const lines = spec.content.trim().split('\n');
    expect(lines).toHaveLength(2); // en-tête + Rina
    expect(lines[1]).toContain('Rina');
  });

  it('JSON : enveloppe app/entité/lignes', () => {
    const spec = engine.exportLocal('customers', 'json');
    const parsed = JSON.parse(spec.content);
    expect(parsed.app).toBe('scoot-master');
    expect(parsed.entity).toBe('customers');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({ id: 'c1', first_name: 'Rina' });
  });

  it('JSON ventes : remplace l’objet client par son nom (CSV-friendly)', () => {
    repo.saveSale(
      { id: 's1', customer_id: 'c1', items: [{ bike_id: 'b1', unit_price: 900000, quantity: 1 }], status: 'brouillon' },
      actor
    );
    const [row] = JSON.parse(engine.exportLocal('sales', 'json').content).rows;
    expect(row.customer).toBe('Rina Hery');
    expect(row.items).toBeUndefined();
  });
});
