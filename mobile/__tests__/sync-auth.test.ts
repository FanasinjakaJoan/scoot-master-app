/**
 * Résilience auth du moteur de synchronisation (correctifs 401/403) :
 *  - un PUSH/PULL en 401/403 ne purge JAMAIS la file locale ;
 *  - les opérations sont marquées « suspendues pour raison d'authentification »
 *    (statut conservé, tentatives non consommées, message explicite) ;
 *  - le signal `auth_required` persiste pour l'UI (readSyncStatus) ;
 *  - le curseur PULL (`last_pull_since`) n'avance pas sur échec d'auth ;
 *  - le téléversement de sauvegarde mémorise l'attente (`pending_backup_upload`)
 *    et le solde au premier succès avec un jeton valide.
 *
 * Même montage que `backup.test.ts` : SQLite web réel + repositories + moteur.
 */

jest.mock('sql.js/dist/sql-wasm.wasm', () => require.resolve('sql.js/dist/sql-wasm.wasm'), {
  virtual: true,
});
jest.mock('../src/data/local/db', () => jest.requireActual('../src/data/local/db.web'));

type DbModule = typeof import('../src/data/local/db.web');
type ReposModule = typeof import('../src/data/local/repositories');
type EngineModule = typeof import('../src/data/sync/engine');
type ClientModule = typeof import('../src/data/api/client');

const { initLocalDb, localDb } = jest.requireActual('../src/data/local/db.web') as DbModule;
const repo = jest.requireActual('../src/data/local/repositories') as ReposModule;
const engine = jest.requireActual('../src/data/sync/engine') as EngineModule;
const client = jest.requireActual('../src/data/api/client') as ClientModule;

const TABLES = ['bikes', 'customers', 'sales', 'sale_items', 'sync_queue', 'sync_conflicts', 'sync_meta'];
const actor = { userId: 'user-1', deviceId: 'dev-test' };
const realFetch = globalThis.fetch;

/** Réponse d'erreur API conforme au back-end (stub minimal : status/ok/text). */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeAll(async () => {
  await initLocalDb();
});

beforeEach(() => {
  for (const table of TABLES) localDb.runSync(`DELETE FROM ${table}`);
  (globalThis as { fetch?: unknown }).fetch = undefined;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

function seedQueueOps(): void {
  repo.saveBike({ id: 'b1', brand: 'Yamaha', model: 'YBR 125', price: 900000 }, actor);
  repo.saveCustomer({ id: 'c1', first_name: 'Rina', last_name: 'Hery', phone: '0340000000' }, actor);
}

describe('push en 401 : file conservée et suspendue pour auth', () => {
  it('ne purge pas la file, marque les opérations, lève auth_required', async () => {
    seedQueueOps();
    expect(repo.pendingOperations(50, ['pending']).length).toBe(2);

    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () =>
      jsonResponse(401, { error: 'Jeton invalide ou expiré.' })
    ) as unknown as typeof fetch;

    const outcome = await engine.runSyncCycle('jeton-expire', 'dev-test');

    expect(outcome.authRequired).toBe(true);

    // Aucune perte : les 2 opérations sont toujours là…
    const ops = repo.pendingOperations(50, ['pending', 'failed', 'conflict']);
    expect(ops).toHaveLength(2);
    // …toutes « pending » (jamais basculées en échec), avec le message d'auth…
    for (const op of ops) {
      expect(op.status).toBe('pending');
      expect(op.attempts).toBe(0); // la suspension ne consomme pas de tentative
      expect(op.last_error).toBe(engine.AUTH_SUSPENDED_MESSAGE);
    }
    // …et les données locales sont intactes.
    expect(repo.listBikes({})).toHaveLength(1);
    expect(repo.listCustomers()).toHaveLength(1);

    // Le signal persistant est levé pour l'UI.
    const status = engine.readSyncStatus();
    expect(status.authRequired).toBe(true);
    expect(status.lastError).toBeTruthy();
    expect(status.pendingCount).toBe(2);
  });

  it('un PULL en 401 n avance pas le curseur last_pull_since', async () => {
    seedQueueOps();
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async (_url: string, init?: { method?: string }) =>
      init?.method === 'GET'
        ? jsonResponse(401, { error: 'Authentification requise.' })
        : jsonResponse(200, { serverTime: '2026-01-01T00:00:00.000Z', results: [], stats: { total: 0, ok: 0, conflicts: 0, errors: 0 } })
    ) as unknown as typeof fetch;

    await engine.runSyncCycle('jeton-expire', 'dev-test');

    expect(repo.metaGet('last_pull_since')).toBeFalsy(); // curseur intact
    expect(engine.readSyncStatus().authRequired).toBe(true);
  });
});

describe('reconnexion : la file reprend et les signaux retombent', () => {
  it('après login (jeton valide réinjecté), le push aboutit et purge proprement', async () => {
    seedQueueOps();

    // 1) échec d'auth
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () =>
      jsonResponse(403, { error: 'Droits insuffisants.' })
    ) as unknown as typeof fetch;
    await engine.runSyncCycle('jeton-refuse', 'dev-test');
    expect(repo.pendingOperations(50, ['pending'])).toHaveLength(2);
    expect(engine.readSyncStatus().authRequired).toBe(true);

    // 2) reconnexion : le store lève la suspension puis relance le cycle → succès
    engine.clearAuthSuspension();
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async (_url: string, init?: { method?: string }) =>
      init?.method === 'GET'
        ? jsonResponse(200, { serverTime: '2026-01-02T00:00:00.000Z', changes: [], nextCursor: null })
        : jsonResponse(200, {
            serverTime: '2026-01-02T00:00:00.000Z',
            results: [
              { index: 0, id: 'b1', entity: 'bikes', status: 'ok' },
              { index: 1, id: 'c1', entity: 'customers', status: 'ok' },
            ],
            stats: { total: 2, ok: 2, conflicts: 0, errors: 0 },
          })
    ) as unknown as typeof fetch;

    const outcome = await engine.runSyncCycle('jeton-frais', 'dev-test');
    expect(outcome.authRequired).toBeFalsy();
    expect(outcome.pushed).toBe(2);
    expect(repo.pendingOperations(50, ['pending', 'failed', 'conflict'])).toHaveLength(0);
    const status = engine.readSyncStatus();
    expect(status.authRequired).toBe(false);
    expect(status.lastError).toBeNull();
  });
});

describe('téléversement de sauvegarde : attente post-réauth', () => {
  it('401 → pending_backup_upload mémorisé ; succès → soldé', async () => {
    seedQueueOps();

    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () =>
      jsonResponse(401, { error: 'Authentification requise.' })
    ) as unknown as typeof fetch;
    await expect(engine.uploadLocalBackup('jeton-expire', 'scoot-backup.json')).rejects.toBeInstanceOf(client.ApiError);
    expect(repo.metaGet('pending_backup_upload')).toBe('1');

    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () =>
      jsonResponse(201, { ok: true, file: 'scoot-backup.json' })
    ) as unknown as typeof fetch;
    const file = await engine.uploadLocalBackup('jeton-frais', 'scoot-backup.json');
    expect(file).toBe('scoot-backup.json');
    expect(repo.metaGet('pending_backup_upload')).toBe('0');
  });
});
