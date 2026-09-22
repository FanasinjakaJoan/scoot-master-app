/**
 * Sauvegarde Firebase côté app — déclenchement manuel (admin), consultation de
 * l'état, listing des fichiers et restauration, avec maintien de session.
 *
 * Même montage que `sync-auth.test.ts` : moteur réel + `fetch` remplacé, donc
 * ce sont bien les appels HTTP construits par le client qui sont vérifiés.
 */

jest.mock('sql.js/dist/sql-wasm.wasm', () => require.resolve('sql.js/dist/sql-wasm.wasm'), {
  virtual: true,
});
jest.mock('../src/data/local/db', () => jest.requireActual('../src/data/local/db.web'));

type DbModule = typeof import('../src/data/local/db.web');
type EngineModule = typeof import('../src/data/sync/engine');

const { initLocalDb, localDb } = jest.requireActual('../src/data/local/db.web') as DbModule;
const engine = jest.requireActual('../src/data/sync/engine') as EngineModule;

const TABLES = ['bikes', 'customers', 'sales', 'sale_items', 'sync_queue', 'sync_conflicts', 'sync_meta'];
const realFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Capture les requêtes pour vérifier méthode, chemin et corps envoyés. */
function captureFetch(handler: (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Response) {
  const calls: { url: string; method?: string; body?: unknown; headers?: Record<string, string> }[] = [];
  (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined, headers: init?.headers });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return calls;
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

describe('déclenchement manuel de la sauvegarde Firebase', () => {
  it('POST /api/exports/backups/firebase avec le jeton, renvoie le run success', async () => {
    const calls = captureFetch(() =>
      jsonResponse(201, {
        id: 'run-1', reason: 'manual', actor: 'admin', startedAt: '2026-09-22T10:00:00.000Z',
        finishedAt: '2026-09-22T10:00:01.000Z', durationMs: 1000, size: 2048,
        status: 'success', path: 'backups/scoot-backup-2026-09-22T10-00-00.json', kind: 'json', error: null,
      })
    );

    const run = await engine.triggerFirebaseBackup('jeton-admin');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/exports/backups/firebase');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers?.Authorization).toBe('Bearer jeton-admin');
    expect(run.status).toBe('success');
    expect(run.size).toBe(2048);
    expect(run.reason).toBe('manual');
  });

  it('propage l’échec distant (502) avec la raison, sans la masquer', async () => {
    captureFetch(() => jsonResponse(502, {
      id: 'run-2', reason: 'manual', actor: 'admin', startedAt: '2026-09-22T10:00:00.000Z',
      finishedAt: '2026-09-22T10:00:02.000Z', durationMs: 2000, size: null,
      status: 'failure', path: null, error: 'permission denied',
    }));

    await expect(engine.triggerFirebaseBackup('jeton-admin')).rejects.toThrow(/permission denied/);
  });

  it('401 puis renouvellement de session réussit : rejoue l’appel avec le jeton frais', async () => {
    let attempt = 0;
    const calls = captureFetch(() => {
      attempt++;
      return attempt === 1
        ? jsonResponse(401, { error: 'Session expirée', expired: true })
        : jsonResponse(201, {
            id: 'run-3', reason: 'manual', actor: 'admin', startedAt: '2026-09-22T10:00:00.000Z',
            finishedAt: '2026-09-22T10:00:01.000Z', durationMs: 1000, size: 10,
            status: 'success', path: 'backups/x.json', error: null,
          });
    });
    const keeper = { refreshSession: jest.fn(async () => ({ ok: true as const, token: 'jeton-frais' })) };

    const run = await engine.triggerFirebaseBackup('jeton-expire', keeper);

    expect(run.status).toBe('success');
    expect(keeper.refreshSession).toHaveBeenCalled();
    expect(calls).toHaveLength(2);
    expect(calls[1].headers?.Authorization).toBe('Bearer jeton-frais');
  });

  it('interruption réseau (fetch indisponible) : message temporaire et pas de fuite d’erreur brute', async () => {
    // fetch absent → apiCall lève ApiError(0, 'Aucune connexion réseau.')
    await expect(engine.triggerFirebaseBackup('jeton-admin')).rejects.toThrow(/interruption temporaire/i);
  });
});

describe('état et fichiers de sauvegarde', () => {
  it('lit l’état (bucket, intervalle, dernier run, historique)', async () => {
    captureFetch(() => jsonResponse(200, {
      enabled: true, ready: true, bucket: 'scoot-backups', prefix: 'backups/',
      intervalHours: 24, retention: 30, mode: 'json', running: false,
      lastRun: { id: 'r', reason: 'scheduled', actor: null, startedAt: '2026-09-22T00:00:00.000Z', finishedAt: '2026-09-22T00:00:01.000Z', durationMs: 1000, size: 512, status: 'success', path: 'backups/a.json', error: null },
      history: [],
    }));

    const state = await engine.readFirebaseBackupStatus('jeton-admin');
    expect(state.ready).toBe(true);
    expect(state.bucket).toBe('scoot-backups');
    expect(state.intervalHours).toBe(24);
    expect(state.lastRun?.status).toBe('success');
  });

  it('liste les fichiers du bucket (dernier en tête)', async () => {
    captureFetch(() => jsonResponse(200, {
      items: [
        { path: 'backups/scoot-backup-2026-09-22T10-00-00.json', size: 2048, updatedAt: '2026-09-22T10:00:00.000Z' },
        { path: 'backups/scoot-backup-2026-09-21T10-00-00.json', size: 1024, updatedAt: '2026-09-21T10:00:00.000Z' },
      ],
    }));

    const files = await engine.listFirebaseBackups('jeton-admin');
    expect(files).toHaveLength(2);
    expect(files[0].path).toContain('2026-09-22');
  });
});

describe('restauration d’une sauvegarde précise', () => {
  it('POST restore avec le chemin choisi et renvoie le décompte appliqué', async () => {
    const calls = captureFetch(() => jsonResponse(200, {
      ok: true,
      path: 'backups/scoot-backup-2026-09-22T10-00-00.json',
      applied: { bikes: 11, customers: 5, sales: 3, sale_items: 3, skipped: [] },
    }));

    const result = await engine.restoreFirebase('jeton-admin', 'backups/scoot-backup-2026-09-22T10-00-00.json');

    expect(calls[0].url).toContain('/api/exports/backups/firebase/restore');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ path: 'backups/scoot-backup-2026-09-22T10-00-00.json' });
    expect(result.applied.bikes).toBe(11);
  });

  it('propage un 400 (chemin manquant) sans le masquer', async () => {
    captureFetch(() => jsonResponse(400, { error: 'Corps JSON {path: "backups/…json"} requis.' }));
    await expect(engine.restoreFirebase('jeton-admin', '')).rejects.toThrow(/path/);
  });
});
