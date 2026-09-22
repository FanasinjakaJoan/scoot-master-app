import { pushOperations, pullChanges, uploadBackup, firebaseBackupStatus, firebaseBackupFiles, runFirebaseBackup, restoreFirebaseBackup, ApiError } from '../api/client';
import type { FirebaseBackupStatus, FirebaseBackupRun } from '../api/client';
import { localDb } from '../local/db';
import * as repo from '../local/repositories';
import { PUSH_BATCH_SIZE, MAX_ATTEMPTS } from '../../lib/config';
import { needsRefresh } from '../../lib/jwt';
import { toCsv, CsvColumn } from '../../lib/csv';
import type { User, SyncStatus } from '../../types';

/**
 * Moteur de synchronisation offline-first — SESSION PERMANENTE.
 *
 * Nouvelle règle : 401/403 pendant push/pull = interruption réseau temporaire.
 * - On NE déclenche PAS de déconnexion ni d'état sessionExpired.
 * - On garde les données en attente localement et on re-tente au prochain cycle.
 * - Le message "Votre session a expiré pendant la synchronisation" est supprimé.
 * - La session ne prend fin QUE sur déconnexion explicite (doLogout).
 */

export type SessionRefreshResult =
  | { ok: true; token: string }
  | { ok: false; refused: boolean };

export interface SyncSessionKeeper {
  refreshSession: () => Promise<SessionRefreshResult>;
}

export interface SyncOutcome {
  pushed: number;
  conflicts: number;
  errors: number;
  pulled: number;
  serverTime: string | null;
  error?: string;
  authRequired?: boolean;
  authRefused?: boolean;
  sessionRenewed?: boolean;
}

const EPOCH = '1970-01-01T00:00:00.000Z';

// Ancien message d'auth suspendue — conservé pour compat mais non utilisé en session permanente.
export const AUTH_SUSPENDED_MESSAGE = 'Synchronisation en attente — interruption temporaire, réessai planifié.';

const META_AUTH_REQUIRED = 'auth_required';
const META_LAST_ERROR = 'last_sync_error';

export function isAuthError(e: unknown): e is ApiError {
  return e instanceof ApiError && (e.status === 401 || e.status === 403);
}

export function wasRefreshRefused(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null &&
    (e as { refreshRefused?: boolean }).refreshRefused === true
  );
}

function stampRefreshRefused(e: unknown, refused: boolean): void {
  if (refused && typeof e === 'object' && e !== null) {
    (e as { refreshRefused?: boolean }).refreshRefused = true;
  }
}

/**
 * Ancienne suspension pour auth — désormais NO-OP en session permanente.
 * On garde la fonction pour compatibilité mais elle ne marque plus auth_required.
 */
function suspendQueueForAuth(): void {
  // Session permanente : on NE suspend PAS pour raison d'auth.
  // On garde simplement la file en pending et on laisse le cycle suivant retenter.
  repo.metaSet(META_AUTH_REQUIRED, '0');
}

export function clearAuthSuspension(): void {
  repo.metaSet(META_AUTH_REQUIRED, '0');
  repo.metaSet(META_LAST_ERROR, '');
}

// ---------------------------------------------------------------------
// Maintien de session pendant la transmission (proactif + réactif)
// ---------------------------------------------------------------------

interface CycleAuth {
  keeper?: SyncSessionKeeper;
  renewed: boolean;
  refused: boolean;
}

async function maybeProactiveRefresh(current: string, auth: CycleAuth): Promise<string> {
  if (!auth.keeper || auth.refused || !needsRefresh(current)) return current;
  try {
    const r = await auth.keeper.refreshSession();
    if (r.ok) {
      auth.renewed = true;
      return r.token;
    }
    // En session permanente, même un refus est traité comme transitoire.
    if (r.refused) auth.refused = false;
  } catch { /* best-effort */ }
  return current;
}

async function tryHealSession(auth: CycleAuth): Promise<string | null> {
  if (!auth.keeper || auth.refused) return null;
  try {
    const r = await auth.keeper.refreshSession();
    if (r.ok) {
      auth.renewed = true;
      return r.token;
    }
    if (r.refused) auth.refused = false;
    return null;
  } catch {
    return null;
  }
}

export interface PushOutcome {
  pushed: number;
  conflicts: number;
  errors: number;
  token: string;
  sessionRenewed: boolean;
  authRefused: boolean;
}

export async function pushQueue(token: string, deviceId: string, maxBatches = 10, keeper?: SyncSessionKeeper): Promise<PushOutcome> {
  let pushed = 0;
  let conflicts = 0;
  let errors = 0;
  let current = token;
  const auth: CycleAuth = { keeper, renewed: false, refused: false };

  for (let batch = 0; batch < maxBatches; batch++) {
    const batchOps = repo.pendingOperations(PUSH_BATCH_SIZE, ['pending', 'failed']);
    if (!batchOps.length) break;

    current = await maybeProactiveRefresh(current, auth);

    let res;
    try {
      res = await pushOperations(current, deviceId, batchOps);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 0 || e.status === 403)) {
        // Hors ligne ou accès refusé : interruption temporaire, pas de déconnexion
        break;
      }
      if (e instanceof ApiError && e.status === 401) {
        // 401 : tentative de renouvellement silencieux, puis rejeu du lot
        const healed = await tryHealSession(auth);
        if (healed) {
          current = healed;
          try {
            res = await pushOperations(current, deviceId, batchOps);
          } catch (retryError) {
            if (retryError instanceof ApiError && (retryError.status === 0 || retryError.status === 401 || retryError.status === 403)) break;
            throw retryError;
          }
        } else {
          // Échec du refresh : on garde la file et on re-tentera
          break;
        }
      } else {
        throw e;
      }
    }

    if (!res) break;

    res.results.forEach((r, i) => {
      const op = batchOps[i];
      if (!op) return;
      if (r.status === 'ok') {
        if (op.entity === 'sales' && r.saleNumber) {
          localDbUpdateSaleNumber(op.entity_id, r.saleNumber);
        }
        repo.removeQueueOperation(op.id);
        pushed++;
      } else if (r.status === 'conflict') {
        repo.markQueueOperation(op.id, {
          status: 'conflict',
          attempts: op.attempts + 1,
          lastError: 'Le serveur possède une version plus récente.',
        });
        if (r.server) repo.upsertConflict(op.id, op.entity, op.entity_id, r.server);
        conflicts++;
      } else {
        const attempts = op.attempts + 1;
        repo.markQueueOperation(op.id, {
          status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
          attempts,
          lastError: r.error || 'Erreur serveur inconnue.',
        });
        errors++;
      }
    });
  }
  return { pushed, conflicts, errors, token: current, sessionRenewed: auth.renewed, authRefused: false };
}

function localDbUpdateSaleNumber(saleId: string, saleNumber: string): void {
  localDb.runSync('UPDATE sales SET sale_number = ? WHERE id = ?', saleNumber, saleId);
}

export async function pullChangesLocal(token: string, keeper?: SyncSessionKeeper): Promise<{ pulled: number; serverTime: string; sessionRenewed: boolean; authRefused: boolean }> {
  const since = repo.metaGet('last_pull_since') || EPOCH;
  let current = token;
  const auth: CycleAuth = { keeper, renewed: false, refused: false };
  let cursor: string | null = null;
  let pulled = 0;
  let serverTime = since;
  let safety = 0;
  let interrupted = false;

  try {
    do {
      current = await maybeProactiveRefresh(current, auth);
      let page;
      try {
        page = await pullChanges(current, since, cursor, 500);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 0 || e.status === 403)) {
          interrupted = true;
          break;
        }
        if (e instanceof ApiError && e.status === 401) {
          const healed = await tryHealSession(auth);
          if (healed) {
            current = healed;
            try {
              page = await pullChanges(current, since, cursor, 500);
            } catch (retryError) {
              if (retryError instanceof ApiError && (retryError.status === 0 || retryError.status === 401 || retryError.status === 403)) {
                interrupted = true;
                break;
              }
              throw retryError;
            }
          } else {
            interrupted = true;
            break;
          }
        } else {
          throw e;
        }
      }
      if (!page) break;
      serverTime = page.serverTime;
      for (const change of page.changes) {
        const applied = repo.applyServerChange(
          change.entity as 'bikes' | 'customers' | 'sales',
          change.id,
          change.op,
          change.updatedAt,
          change.data
        );
        if (applied) pulled++;
      }
      cursor = page.nextCursor;
      safety++;
    } while (cursor && safety < 50);
  } catch (e) {
    throw e;
  }

  if (!interrupted) {
    repo.metaSet('last_pull_since', serverTime);
  }
  return { pulled, serverTime, sessionRenewed: auth.renewed, authRefused: false };
}

export async function runSyncCycle(token: string, deviceId: string, keeper?: SyncSessionKeeper): Promise<SyncOutcome> {
  const outcome: SyncOutcome = { pushed: 0, conflicts: 0, errors: 0, pulled: 0, serverTime: null };
  try {
    const push = await pushQueue(token, deviceId, 10, keeper);
    outcome.pushed = push.pushed;
    outcome.conflicts = push.conflicts;
    outcome.errors = push.errors;
    if (push.sessionRenewed) outcome.sessionRenewed = true;
    const pull = await pullChangesLocal(push.token, keeper);
    outcome.pulled = pull.pulled;
    outcome.serverTime = pull.serverTime;
    if (pull.sessionRenewed) outcome.sessionRenewed = true;
    if (repo.metaGet(META_AUTH_REQUIRED) === '1') clearAuthSuspension();
    repo.metaSet('last_sync_at', new Date().toISOString());
    repo.metaSet(META_LAST_ERROR, '');
    return outcome;
  } catch (e) {
    if (isAuthError(e)) {
      // Session permanente : 401/403 = interruption réseau temporaire, pas de déconnexion.
      outcome.authRequired = false;
      outcome.authRefused = false;
      outcome.error = 'Synchronisation en attente — interruption temporaire (réseau/auth), réessai planifié. Données conservées localement.';
    } else {
      outcome.error = e instanceof Error ? e.message : 'Erreur de synchronisation inconnue.';
      repo.metaSet(META_LAST_ERROR, outcome.error);
    }
    return outcome;
  }
}

export function resolveConflictKeepServer(queueId: number): void {
  const conflict = repo.listConflicts().find((c) => c.queue_id === queueId);
  const op = repo.queueOperationById(queueId);
  if (!conflict || !op) return;
  const serverData = conflict.server_data as { updated_at?: string; deleted_at?: string } & Record<string, unknown>;
  const ts = serverData.updated_at || conflict.detected_at;
  repo.applyServerChange(op.entity, op.entity_id, 'upsert', ts, serverData);
  repo.removeQueueOperation(queueId);
}

export async function resolveConflictForceMine(token: string, deviceId: string, queueId: number, user: User, keeper?: SyncSessionKeeper): Promise<boolean> {
  if (user.role !== 'admin') {
    throw new Error('La validation administrative (forcer) est réservée au rôle admin.');
  }
  const op = repo.queueOperationById(queueId);
  if (!op) return false;
  repo.markQueueOperation(queueId, { status: 'pending', force: true, lastError: null });
  const [updated] = repo.pendingOperations(1000).filter((o) => o.id === queueId);
  if (!updated) return false;
  const auth: CycleAuth = { keeper, renewed: false, refused: false };
  let current = await maybeProactiveRefresh(token, auth);
  let res;
  try {
    res = await pushOperations(current, deviceId, [updated]);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 0)) {
      const healed = await tryHealSession(auth);
      if (!healed) throw new Error('Synchronisation en attente — interruption temporaire, réessai planifié.');
      current = healed;
      res = await pushOperations(current, deviceId, [updated]);
    } else {
      throw e;
    }
  }
  const r = res.results[0];
  if (r.status === 'ok') {
    if (updated.entity === 'sales' && r.saleNumber) localDbUpdateSaleNumber(updated.entity_id, r.saleNumber);
    repo.removeQueueOperation(queueId);
    return true;
  }
  repo.markQueueOperation(queueId, { status: 'conflict', lastError: r.error || 'Conflit persistant.' });
  return false;
}

export function retryFailedOperation(queueId: number): void {
  repo.markQueueOperation(queueId, { status: 'pending', attempts: 0, lastError: null });
}

export function readSyncStatus(): SyncStatus {
  const stats = repo.queueStats();
  const lastError = repo.metaGet(META_LAST_ERROR);
  return {
    syncing: false,
    lastSyncAt: repo.metaGet('last_sync_at'),
    lastError: lastError ? lastError : null,
    authRequired: false,
    pendingCount: stats.pending,
    conflictCount: stats.conflict,
    failedCount: stats.failed,
  };
}

export interface ExportSpec {
  fileName: string;
  content: string;
  mime: string;
}

const BIKE_COLUMNS: CsvColumn[] = [
  { key: 'id', header: 'ID' }, { key: 'brand', header: 'Marque' }, { key: 'model', header: 'Modèle' },
  { key: 'year', header: 'Année' }, { key: 'mileage_km', header: 'Kilométrage' }, { key: 'engine_cc', header: 'Cylindrée' },
  { key: 'color', header: 'Couleur' }, { key: 'serial_number', header: 'N° série' }, { key: 'price', header: 'Prix (Ar)' },
  { key: 'mechanical_state', header: 'État mécanique (1-5)' }, { key: 'aesthetic_state', header: 'État esthétique (1-5)' },
  { key: 'status', header: 'Statut' }, { key: 'warehouse', header: 'Magasin' }, { key: 'updated_at', header: 'Mis à jour' },
];
const CUSTOMER_COLUMNS: CsvColumn[] = [
  { key: 'id', header: 'ID' }, { key: 'first_name', header: 'Prénom' }, { key: 'last_name', header: 'Nom' },
  { key: 'phone', header: 'Téléphone' }, { key: 'email', header: 'Email' }, { key: 'address', header: 'Adresse' },
  { key: 'updated_at', header: 'Mis à jour' },
];
const SALE_COLUMNS: CsvColumn[] = [
  { key: 'id', header: 'ID' }, { key: 'sale_number', header: 'N° bon' }, { key: 'customer_id', header: 'Client ID' },
  { key: 'total', header: 'Total (Ar)' }, { key: 'discount', header: 'Remise (Ar)' }, { key: 'amount_paid', header: 'Payé (Ar)' },
  { key: 'payment_method', header: 'Paiement' }, { key: 'payment_status', header: 'Statut paiement' },
  { key: 'status', header: 'Statut' }, { key: 'sale_date', header: 'Date' },
];

export function exportLocal(entity: 'bikes' | 'customers' | 'sales', format: 'json' | 'csv'): ExportSpec {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const data =
    entity === 'bikes'
      ? repo.listBikes({ limit: 1000 })
      : entity === 'customers'
        ? repo.listCustomers(undefined, 1000)
        : repo.listSales({ limit: 1000 }).map((s) => ({ ...s, items: undefined, customer: s.customer ? `${s.customer.first_name} ${s.customer.last_name}` : null }));

  if (format === 'csv') {
    const cols = entity === 'bikes' ? BIKE_COLUMNS : entity === 'customers' ? CUSTOMER_COLUMNS : SALE_COLUMNS;
    return { fileName: `scoot-${entity}-${stamp}.csv`, content: toCsv(data as unknown as Record<string, unknown>[], cols), mime: 'text/csv' };
  }
  return {
    fileName: `scoot-${entity}-${stamp}.json`,
    content: JSON.stringify({ app: 'scoot-master', entity, exportedAt: new Date().toISOString(), rows: data }, null, 2),
    mime: 'application/json',
  };
}

export function localBackupSpec(): ExportSpec {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return {
    fileName: `scoot-backup-${stamp}.json`,
    content: JSON.stringify(repo.localBackup(), null, 2),
    mime: 'application/json',
  };
}

export async function uploadLocalBackup(token: string, fileName: string, keeper?: SyncSessionKeeper): Promise<string> {
  const auth: CycleAuth = { keeper, renewed: false, refused: false };
  const current = await maybeProactiveRefresh(token, auth);
  try {
    const res = await uploadBackup(current, fileName, repo.localBackup());
    repo.metaSet('pending_backup_upload', '0');
    return res.file;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 0)) {
      const healed = await tryHealSession(auth);
      if (healed) {
        try {
          const res = await uploadBackup(healed, fileName, repo.localBackup());
          repo.metaSet('pending_backup_upload', '0');
          return res.file;
        } catch (retryError) {
          if (retryError instanceof ApiError) repo.metaSet('pending_backup_upload', '1');
          throw retryError;
        }
      }
      repo.metaSet('pending_backup_upload', '1');
      throw new Error('Sauvegarde en attente — interruption temporaire, réessai planifié.');
    }
    if (isAuthError(e)) {
      repo.metaSet('pending_backup_upload', '1');
    }
    throw e;
  }
}

// ---------------------------------------------------------------------
// Sauvegarde Firebase — déclenchement manuel et restauration (admin)
// ---------------------------------------------------------------------

/**
 * Exécute un appel admin en maintenant la session (renouvellement proactif puis
 * réactif), avec un message d'erreur explicite en cas d'interruption réseau.
 */
async function withSession<T>(token: string, keeper: SyncSessionKeeper | undefined, call: (t: string) => Promise<T>): Promise<T> {
  const auth: CycleAuth = { keeper, renewed: false, refused: false };
  let current = await maybeProactiveRefresh(token, auth);
  try {
    return await call(current);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 0)) {
      const healed = await tryHealSession(auth);
      if (healed) {
        current = healed;
        return await call(current);
      }
      throw new Error('Sauvegarde Firebase en attente — interruption temporaire, réessai planifié.');
    }
    throw e;
  }
}

/** État et historique de la sauvegarde Firebase (admin). */
export function readFirebaseBackupStatus(token: string, keeper?: SyncSessionKeeper): Promise<FirebaseBackupStatus> {
  return withSession(token, keeper, (t) => firebaseBackupStatus(t));
}

/**
 * Déclenche une sauvegarde immédiate vers Firebase (admin). Le serveur répond
 * `status: 'success' | 'failure' | 'skipped'` ; une erreur réseau lève, un échec
 * distant est renvoyé tel quel pour que l'interface affiche la raison.
 */
export function triggerFirebaseBackup(token: string, keeper?: SyncSessionKeeper): Promise<FirebaseBackupRun> {
  return withSession(token, keeper, (t) => runFirebaseBackup(t));
}

/** Sauvegarde Firebase : restauration d'un fichier précis (admin). */
export function listFirebaseBackups(token: string, keeper?: SyncSessionKeeper): Promise<{ path: string; size: number; updatedAt: string | null }[]> {
  return withSession(token, keeper, (t) => firebaseBackupFiles(t).then((r) => r.items));
}

/** Restaure un fichier de sauvegarde Firebase précis (admin). */
export function restoreFirebase(token: string, path: string, keeper?: SyncSessionKeeper): Promise<{ ok: boolean; path: string; applied: Record<string, number> }> {
  return withSession(token, keeper, (t) => restoreFirebaseBackup(t, path));
}
