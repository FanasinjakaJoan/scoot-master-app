/**
 * Maintien de session PENDANT la synchronisation — SESSION PERMANENTE :
 *  - 401/403 = interruption temporaire, pas de déconnexion
 *  - renouvellement silencieux en arrière-plan, jamais bloquant
 *  - refus explicite traité comme transitoire (on garde la session)
 *  - 403 = pas de tentative de renouvellement, file conservée
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

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeToken(expiresInMs: number): string {
  const exp = Math.floor((Date.now() + expiresInMs) / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u1', exp })}.signature-fake`;
}

const LONG_LIVED = () => makeToken(30 * 86400 * 1000);
const EXPIRING_SOON = () => makeToken(10 * 60 * 1000);

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
  it('renouvelle une fois et termine le cycle sans déconnecter', async () => {
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

    const pushes = calls.filter((c) => c.url.includes('/api/sync/push'));
    expect(pushes).toHaveLength(2);
    expect(pushes[0].auth).toBe('Bearer stale-token');
    expect(pushes[1].auth).toBe(`Bearer ${fresh}`);
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

    const gets = calls.filter((c) => c.method === 'GET');
    expect(gets).toHaveLength(3);
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

  it('refus proactif traité comme transitoire en session permanente (pas de déconnexion)', async () => {
    seedQueueOps();
    const keeper = keeperReturning({ ok: false, refused: true });
    stubFetch((call) =>
      call.url.includes('/api/sync/push')
        ? jsonResponse(401, { error: 'Session expirée.' })
        : jsonResponse(200, PULL_EMPTY)
    );

    const outcome = await engine.runSyncCycle(EXPIRING_SOON(), 'dev-test', keeper);

    // Session permanente : même un refus est traité comme interruption temporaire
    expect(outcome.authRequired).toBeFalsy();
    expect(outcome.authRefused).toBeFalsy();
    // En session permanente, le refus n'est pas marqué comme définitif, donc
    // le pull proactif peut aussi tenter un refresh → 2 appels au total.
    expect(keeper.refreshSession).toHaveBeenCalled();
    // File conservée, pas de déconnexion
    expect(repo.pendingOperations(50, ['pending'])).toHaveLength(2);
  });
});

describe('échec du maintien : traité comme interruption temporaire (session permanente)', () => {
  it('refus explicite → pas de déconnexion, file intacte, réessai planifié', async () => {
    seedQueueOps();
    const keeper = keeperReturning({ ok: false, refused: true });
    stubFetch((call) =>
      call.url.includes('/api/sync/push')
        ? jsonResponse(401, { error: 'Jeton invalide.' })
        : jsonResponse(200, PULL_EMPTY)
    );

    const outcome = await engine.runSyncCycle('stale-token', 'dev-test', keeper);

    expect(outcome.authRequired).toBeFalsy();
    expect(outcome.authRefused).toBeFalsy();
    const ops = repo.pendingOperations(50, ['pending', 'failed', 'conflict']);
    expect(ops).toHaveLength(2);
    for (const op of ops) {
      expect(op.status).toBe('pending');
      expect(op.attempts).toBe(0);
    }
    expect(engine.readSyncStatus().authRequired).toBe(false);
  });

  it('panne transitoire → pas de déconnexion, file intacte', async () => {
    seedQueueOps();
    const keeper = keeperReturning({ ok: false, refused: false });
    stubFetch((call) =>
      call.url.includes('/api/sync/push')
        ? jsonResponse(401, { error: 'Session expirée.', expired: true })
        : jsonResponse(200, PULL_EMPTY)
    );

    const outcome = await engine.runSyncCycle('stale-token', 'dev-test', keeper);

    expect(outcome.authRequired).toBeFalsy();
    expect(repo.pendingOperations(50, ['pending'])).toHaveLength(2);
    expect(engine.readSyncStatus().authRequired).toBe(false);
  });

  it('403 → aucun renouvellement tenté, file conservée, pas de déconnexion', async () => {
    seedQueueOps();
    const keeper = keeperReturning({ ok: true, token: LONG_LIVED() });
    stubFetch((call) =>
      call.url.includes('/api/sync/push')
        ? jsonResponse(403, { error: 'Droits insuffisants.' })
        : jsonResponse(200, PULL_EMPTY)
    );

    const outcome = await engine.runSyncCycle('valid-token', 'dev-test', keeper);

    expect(outcome.authRequired).toBeFalsy();
    expect(keeper.refreshSession).not.toHaveBeenCalled();
    const ops = repo.pendingOperations(50, ['pending']);
    expect(ops).toHaveLength(2);
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
  });
});

describe('sauvegarde : session maintenue pendant le téléversement', () => {
  it('401 → renouvellement → téléversement rejoué', async () => {
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
