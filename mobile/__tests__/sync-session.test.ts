/**
 * Maintien de session PENDANT la synchronisation des données :
 *  - renouvellement PROACTIF entre deux lots/pages quand le jeton approche de
 *    l'échéance (un cycle long ne bute jamais sur une expiration prévisible) ;
 *  - sur 401 en cours de transmission : UN renouvellement puis la requête est
 *    rejouée avec le jeton frais (lot push, page pull au même curseur, force
 *    administrative, téléversement de sauvegarde) ;
 *  - refus explicite du serveur → `authRefused` (vraie fin de session) ;
 *  - panne transitoire → `authRequired` SANS `authRefused` (garder la session) ;
 *  - 403 → aucune tentative de renouvellement (le jeton est valide, l'accès
 *    est refusé), suspension comme avant.
 *
 * Même montage que `sync-auth.test.ts` : SQLite web réel + repositories +
 * moteur, `fetch` stubé, keeper de session injecté (pas de vrai /refresh).
 */

jest.mock('sql.js/dist/sql-wasm.wasm', () => require.resolve('sql.js/dist/sql-wasm.wasm'), {
  virtual: true,
});
jest.mock('../src/data/local/db', () => jest.requireActual('../src/data/local/db.web'));

type DbModule = typeof import('../src/data/local/db.web');
type ReposModule = typeof import('../src/data/local/repositories');
type EngineModule = typeof import('../src/data/sync/engine');
import type { SyncSessionKeeper, SessionRefreshResult } from '../src/data/sync/engine';
import type { User } from '../src/types';

const { initLocalDb, localDb } = jest.requireActual('../src/data/local/db.web') as DbModule;
const repo = jest.requireActual('../src/data/local/repositories') as ReposModule;
const engine = jest.requireActual('../src/data/sync/engine') as EngineModule;

const TABLES = ['bikes', 'customers', 'sales', 'sale_items', 'sync_queue', 'sync_conflicts', 'sync_meta'];
const actor = { userId: 'user-1', deviceId: 'dev-test' };
const realFetch = globalThis.fetch;

interface SeenCall {
  url: string;
  method: string;
  auth?: string;
  body?: Record<string, unknown>;
}

/** Réponse API conforme au back-end (stub minimal : status/ok/text). */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Forge un JWT local (signature factice) expirant dans `expiresInMs`. */
function makeToken(expiresInMs: number): string {
  const exp = Math.floor((Date.now() + expiresInMs) / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u1', exp })}.signature-fake`;
}

const LONG_LIVED = () => makeToken(30 * 86400 * 1000); // needsRefresh: false
const EXPIRING_SOON = () => makeToken(10 * 60 * 1000); // needsRefresh: true (horizon 30 min)

function keeperReturning(result: SessionRefreshResult): SyncSessionKeeper & { refreshSession: jest.Mock } {
  return { refreshSession: jest.fn(async () => result) };
}

function seedQueueOps(): void {
  repo.saveBike({ id: 'b1', brand: 'Yamaha', model: 'YBR 125', price: 900000 }, actor);
  repo.saveCustomer({ id: 'c1', first_name: 'Rina', last_name: 'Hery', phone: '0340000000' }, actor);
}

const PUSH_OK = {
  serverTime: '2026-02-01T00:00:00.000Z',
  results: [
    { index: 0, id: 'b1', entity: 'bikes', status: 'ok' },
    { index: 1, id: 'c1', entity: 'customers', status: 'ok' },
  ],
  stats: { total: 2, ok: 2, conflicts: 0, errors: 0 },
};
const PULL_EMPTY = { serverTime: '2026-02-01T00:00:00.000Z', changes: [], nextCursor: null };

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

function stubFetch(handler: (call: SeenCall) => Response): SeenCall[] {
  const calls: SeenCall[] = [];
  (globalThis as { fetch?: unknown }).fetch = jest.fn(
    async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const call: SeenCall = {
        url,
        method: init?.method || 'GET',
        auth: init?.headers?.Authorization,
        body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      };
      calls.push(call);
      return handler(call);
    }
  ) as unknown as typeof fetch;
  return calls;
}

describe('push : 401 en cours de transmission → session maintenue, lot rejoué', () => {
  it('renouvelle une fois et termine le cycle sans suspendre ni déconnecter', async () => {
    seedQueueOps();
    const fresh = LONG_LIVED();
    const keeper = keeperReturning({ ok: true, token: fresh });
    const calls = stubFetch((call) => {
      if (call.url.includes('/api/sync/push')) {
        return call.auth === 'Bearer stale-token'
          ? jsonResponse(401, { error: 'Session expirée — renouvellement requis.', expired: true })
          : jsonResponse(200, PUSH_OK);
      }
      return jsonResponse(200, PULL_EMPTY);
    });

    const outcome = await engine.runSyncCycle('stale-token', 'dev-test', keeper);

    expect(outcome.authRequired).toBeFalsy();
    expect(outcome.sessionRenewed).toBe(true);
    expect(outcome.pushed).toBe(2);
    expect(keeper.refreshSession).toHaveBeenCalledTimes(1);
    expect(repo.pendingOperations(50, ['pending', 'failed', 'conflict'])).toHaveLength(0);
    expect(engine.readSyncStatus().authRequired).toBe(false);

    // Le lot rejoué est identique au lot fautif (mêmes opérations), seul le
    // jeton change — aucune donnée n'est perdue ni dupliquée.
    const pushes = calls.filter((c) => c.url.includes('/api/sync/push'));
    expect(pushes).toHaveLength(2);
    expect(pushes[0].auth).toBe('Bearer stale-token');
    expect(pushes[1].auth).toBe(`Bearer ${fresh}`);
    const ops = pushes[1].body?.operations as Array<{ id: string }>;
    expect(ops.map((o) => o.id).sort()).toEqual(['b1', 'c1']);
  });
});

describe('pull : 401 au milieu de la pagination → même page rejouée', () => {
  it('rejoue la page fautive au même curseur, sans doublon ni trou', async () => {
    const fresh = LONG_LIVED();
    const keeper = keeperReturning({ ok: true, token: fresh });
    const T_PAGE = '2026-02-01T10:00:00.000Z';
    const T_END = '2026-02-01T11:00:00.000Z';
    const change = {
      entity: 'bikes', id: 'b9', op: 'upsert',
      updatedAt: '2026-02-01T09:00:00.000Z', version: 1,
      data: {
        brand: 'Honda', model: 'CG 125', price: 1500000, mileage_km: 12000,
        mechanical_state: 4, aesthetic_state: 4, status: 'available',
      },
    };
    let pulls = 0;
    const calls = stubFetch((call) => {
      if (call.url.includes('/api/sync/push')) {
        return jsonResponse(200, { serverTime: T_PAGE, results: [], stats: { total: 0, ok: 0, conflicts: 0, errors: 0 } });
      }
      pulls++;
      if (pulls === 1) return jsonResponse(401, { error: 'Session expirée.', expired: true });
      if (call.url.includes('cursor=')) return jsonResponse(200, { serverTime: T_END, changes: [], nextCursor: null });
      return jsonResponse(200, { serverTime: T_PAGE, changes: [change], nextCursor: 'YzE=' });
    });

    const outcome = await engine.runSyncCycle('stale-token', 'dev-test', keeper);

    expect(outcome.authRequired).toBeFalsy();
    expect(outcome.sessionRenewed).toBe(true);
    expect(outcome.pulled).toBe(1);
    expect(keeper.refreshSession).toHaveBeenCalledTimes(1);
    expect(repo.metaGet('last_pull_since')).toBe(T_END);
    expect(repo.listBikes({})).toHaveLength(1);

    // Page 1 fautive (sans curseur) puis la MÊME page rejouée (sans curseur),
    // puis page 2 (avec curseur) : aucune page rejouée ni sautée.
    const gets = calls.filter((c) => c.method === 'GET');
    expect(gets).toHaveLength(3);
    expect(gets[0].url.includes('cursor=')).toBe(false);
    expect(gets[1].url.includes('cursor=')).toBe(false);
    expect(gets[1].auth).toBe(`Bearer ${fresh}`);
    expect(gets[2].url.includes('cursor=')).toBe(true);
  });
});

describe('renouvellement proactif : jeton proche de l’échéance', () => {
  it('renouvelle AVANT le premier lot — aucun 401, un seul appel push', async () => {
    seedQueueOps();
    const fresh = LONG_LIVED();
    const keeper = keeperReturning({ ok: true, token: fresh });
    const calls = stubFetch((call) =>
      call.url.includes('/api/sync/push') ? jsonResponse(200, PUSH_OK) : jsonResponse(200, PULL_EMPTY)
    );

    const outcome = await engine.runSyncCycle(EXPIRING_SOON(), 'dev-test', keeper);

    expect(outcome.authRequired).toBeFalsy();
    expect(outcome.sessionRenewed).toBe(true);
    expect(outcome.pushed).toBe(2);
    expect(keeper.refreshSession).toHaveBeenCalledTimes(1);
    const pushes = calls.filter((c) => c.url.includes('/api/sync/push'));
    expect(pushes).toHaveLength(1);
    expect(pushes[0].auth).toBe(`Bearer ${fresh}`);
  });

  it('un refus proactif n’est pas retenté en réactif (un seul appel)', async () => {
    seedQueueOps();
    const keeper = keeperReturning({ ok: false, refused: true });
    stubFetch((call) =>
      call.url.includes('/api/sync/push')
        ? jsonResponse(401, { error: 'Session expirée.' })
        : jsonResponse(200, PULL_EMPTY)
    );

    const outcome = await engine.runSyncCycle(EXPIRING_SOON(), 'dev-test', keeper);

    expect(outcome.authRequired).toBe(true);
    expect(outcome.authRefused).toBe(true);
    expect(keeper.refreshSession).toHaveBeenCalledTimes(1);
    expect(repo.pendingOperations(50, ['pending'])).toHaveLength(2);
  });
});

describe('échec du maintien : refus définitif vs panne transitoire', () => {
  it('refus explicite → authRefused (vraie fin de session), file intacte', async () => {
    seedQueueOps();
    const keeper = keeperReturning({ ok: false, refused: true });
    stubFetch((call) =>
      call.url.includes('/api/sync/push')
        ? jsonResponse(401, { error: 'Jeton invalide.' })
        : jsonResponse(200, PULL_EMPTY)
    );

    const outcome = await engine.runSyncCycle('stale-token', 'dev-test', keeper);

    expect(outcome.authRequired).toBe(true);
    expect(outcome.authRefused).toBe(true);
    expect(outcome.sessionRenewed).toBeFalsy();
    const ops = repo.pendingOperations(50, ['pending', 'failed', 'conflict']);
    expect(ops).toHaveLength(2);
    for (const op of ops) {
      expect(op.status).toBe('pending');
      expect(op.attempts).toBe(0);
      expect(op.last_error).toBe(engine.AUTH_SUSPENDED_MESSAGE);
    }
    expect(engine.readSyncStatus().authRequired).toBe(true);
  });

  it('panne transitoire → authRequired SANS authRefused (garder la session)', async () => {
    seedQueueOps();
    const keeper = keeperReturning({ ok: false, refused: false });
    stubFetch((call) =>
      call.url.includes('/api/sync/push')
        ? jsonResponse(401, { error: 'Session expirée.', expired: true })
        : jsonResponse(200, PULL_EMPTY)
    );

    const outcome = await engine.runSyncCycle('stale-token', 'dev-test', keeper);

    expect(outcome.authRequired).toBe(true);
    expect(outcome.authRefused).toBeFalsy();
    expect(repo.pendingOperations(50, ['pending'])).toHaveLength(2);
    expect(engine.readSyncStatus().authRequired).toBe(true);
  });

  it('403 → aucun renouvellement tenté, suspension comme avant', async () => {
    seedQueueOps();
    const keeper = keeperReturning({ ok: true, token: LONG_LIVED() });
    stubFetch((call) =>
      call.url.includes('/api/sync/push')
        ? jsonResponse(403, { error: 'Droits insuffisants.' })
        : jsonResponse(200, PULL_EMPTY)
    );

    const outcome = await engine.runSyncCycle('valid-token', 'dev-test', keeper);

    expect(outcome.authRequired).toBe(true);
    expect(outcome.authRefused).toBeFalsy();
    expect(keeper.refreshSession).not.toHaveBeenCalled();
    const ops = repo.pendingOperations(50, ['pending']);
    expect(ops).toHaveLength(2);
    expect(ops[0].attempts).toBe(0);
  });
});

describe('force administrative : session maintenue pendant l’envoi', () => {
  it('401 → renouvellement → envoi forcé rejoué avec le jeton frais', async () => {
    repo.saveBike({ id: 'b1', brand: 'Yamaha', model: 'YBR 125', price: 900000 }, actor);
    const [op] = repo.pendingOperations(10);
    const fresh = LONG_LIVED();
    const keeper = keeperReturning({ ok: true, token: fresh });
    const admin: User = { id: 'u1', username: 'admin', fullName: 'Admin', role: 'admin' };
    const calls = stubFetch((call) =>
      call.auth === 'Bearer stale-token'
        ? jsonResponse(401, { error: 'Session expirée.', expired: true })
        : jsonResponse(200, {
            serverTime: '2026-02-01T00:00:00.000Z',
            results: [{ index: 0, id: 'b1', entity: 'bikes', status: 'ok' }],
            stats: { total: 1, ok: 1, conflicts: 0, errors: 0 },
          })
    );

    const done = await engine.resolveConflictForceMine('stale-token', 'dev-test', op.id, admin, keeper);

    expect(done).toBe(true);
    expect(keeper.refreshSession).toHaveBeenCalledTimes(1);
    expect(repo.queueOperationById(op.id)).toBeFalsy();
    expect(calls).toHaveLength(2);
    expect(calls[1].auth).toBe(`Bearer ${fresh}`);
    expect((calls[1].body?.operations as Array<{ force?: boolean }>)[0].force).toBe(true);
  });
});

describe('sauvegarde : session maintenue pendant le téléversement', () => {
  it('401 → renouvellement → téléversement rejoué, attente soldée', async () => {
    seedQueueOps();
    const fresh = LONG_LIVED();
    const keeper = keeperReturning({ ok: true, token: fresh });
    stubFetch((call) =>
      call.auth === 'Bearer stale-token'
        ? jsonResponse(401, { error: 'Session expirée.', expired: true })
        : jsonResponse(201, { ok: true, file: 'scoot-backup.json' })
    );

    const file = await engine.uploadLocalBackup('stale-token', 'scoot-backup.json', keeper);

    expect(file).toBe('scoot-backup.json');
    expect(keeper.refreshSession).toHaveBeenCalledTimes(1);
    expect(repo.metaGet('pending_backup_upload')).toBe('0');
  });
});
