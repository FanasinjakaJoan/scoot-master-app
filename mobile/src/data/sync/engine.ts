import { pushOperations, pullChanges, uploadBackup, ApiError } from '../api/client';
import { localDb } from '../local/db';
import * as repo from '../local/repositories';
import { PUSH_BATCH_SIZE, MAX_ATTEMPTS } from '../../lib/config';
import { toCsv, CsvColumn } from '../../lib/csv';
import type { User, SyncStatus } from '../../types';

/**
 * Moteur de synchronisation offline-first.
 *
 * Cycle : 1) PUSH — vide la file locale par lots (le serveur arbitre LWW)
 *         2) PULL — applique les changements serveur plus récents que la copie locale
 * La file locale est la source de vérité hors ligne ; chaque mutation locale
 * (repositories.ts) y dépose une opération avant tout évanouissement possible.
 */

export interface SyncOutcome {
  pushed: number;
  conflicts: number;
  errors: number;
  pulled: number;
  serverTime: string | null;
  error?: string;
}

const EPOCH = '1970-01-01T00:00:00.000Z';

/** Pousse la file locale (par lots) et met à jour son état. */
export async function pushQueue(token: string, deviceId: string, maxBatches = 10): Promise<{ pushed: number; conflicts: number; errors: number }> {
  let pushed = 0;
  let conflicts = 0;
  let errors = 0;

  for (let batch = 0; batch < maxBatches; batch++) {
    // Seuls 'pending' et 'failed' sont re-poussés automatiquement ;
    // 'conflict' attend une résolution humaine (conserver le serveur / forcer).
    const batchOps = repo.pendingOperations(PUSH_BATCH_SIZE, ['pending', 'failed']);
    if (!batchOps.length) break;

    let res;
    try {
      res = await pushOperations(token, deviceId, batchOps);
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) break; // hors ligne : on stoppe proprement
      throw e;
    }

    res.results.forEach((r, i) => {
      const op = batchOps[i];
      if (!op) return;
      if (r.status === 'ok') {
        // Numérotation définitive du bon (ré-affectation serveur possible)
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
  return { pushed, conflicts, errors };
}

function localDbUpdateSaleNumber(saleId: string, saleNumber: string): void {
  // Alignement local sur le numéro définitif servi par le serveur — pas de ré-enfilement
  // (le serveur détient déjà cette valeur ; le prochain pull des autres appareils aussi).
  localDb.runSync('UPDATE sales SET sale_number = ? WHERE id = ?', saleNumber, saleId);
}

/** Tire les changements serveur depuis `since` et les applique (LWW local). */
export async function pullChangesLocal(token: string): Promise<{ pulled: number; serverTime: string }> {
  const since = repo.metaGet('last_pull_since') || EPOCH;
  let cursor: string | null = null;
  let pulled = 0;
  let serverTime = since;
  let safety = 0;

  do {
    const page = await pullChanges(token, since, cursor, 500);
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

  repo.metaSet('last_pull_since', serverTime);
  return { pulled, serverTime };
}

/** Cycle complet de synchronisation (push puis pull). */
export async function runSyncCycle(token: string, deviceId: string): Promise<SyncOutcome> {
  const outcome: SyncOutcome = { pushed: 0, conflicts: 0, errors: 0, pulled: 0, serverTime: null };
  try {
    const push = await pushQueue(token, deviceId);
    outcome.pushed = push.pushed;
    outcome.conflicts = push.conflicts;
    outcome.errors = push.errors;
    const pull = await pullChangesLocal(token);
    outcome.pulled = pull.pulled;
    outcome.serverTime = pull.serverTime;
    repo.metaSet('last_sync_at', new Date().toISOString());
    return outcome;
  } catch (e) {
    outcome.error = e instanceof Error ? e.message : 'Erreur de synchronisation inconnue.';
    return outcome;
  }
}

// =====================================================================
// Résolution des conflits (depuis l'écran Synchronisation)
// =====================================================================

/** Conserver la version SERVEUR : l'applique localement et retire l'opération. */
export function resolveConflictKeepServer(queueId: number): void {
  const conflict = repo.listConflicts().find((c) => c.queue_id === queueId);
  const op = repo.queueOperationById(queueId);
  if (!conflict || !op) return;
  const serverData = conflict.server_data as { updated_at?: string; deleted_at?: string } & Record<string, unknown>;
  const ts = serverData.updated_at || conflict.detected_at;
  repo.applyServerChange(op.entity, op.entity_id, 'upsert', ts, serverData);
  repo.removeQueueOperation(queueId);
}

/** Forcer ma version (admin uniquement) : renvoie l'opération avec force=true. */
export async function resolveConflictForceMine(token: string, deviceId: string, queueId: number, user: User): Promise<boolean> {
  if (user.role !== 'admin') {
    throw new Error('La validation administrative (forcer) est réservée au rôle admin.');
  }
  const op = repo.queueOperationById(queueId);
  if (!op) return false;
  repo.markQueueOperation(queueId, { status: 'pending', force: true, lastError: null });
  const [updated] = repo.pendingOperations(1000).filter((o) => o.id === queueId);
  if (!updated) return false;
  const res = await pushOperations(token, deviceId, [updated]);
  const r = res.results[0];
  if (r.status === 'ok') {
    if (updated.entity === 'sales' && r.saleNumber) localDbUpdateSaleNumber(updated.entity_id, r.saleNumber);
    repo.removeQueueOperation(queueId);
    return true;
  }
  repo.markQueueOperation(queueId, { status: 'conflict', lastError: r.error || 'Conflit persistant.' });
  return false;
}

/** Relance une opération échouée. */
export function retryFailedOperation(queueId: number): void {
  repo.markQueueOperation(queueId, { status: 'pending', attempts: 0, lastError: null });
}

// =====================================================================
// État / statut
// =====================================================================

export function readSyncStatus(): SyncStatus {
  const stats = repo.queueStats();
  return {
    syncing: false,
    lastSyncAt: repo.metaGet('last_sync_at'),
    lastError: null,
    pendingCount: stats.pending,
    conflictCount: stats.conflict,
    failedCount: stats.failed,
  };
}

// =====================================================================
// Export / sauvegarde locale (fonctionne hors ligne)
// =====================================================================

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

/** Exporte une entité depuis la base locale en JSON ou CSV. */
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

/** Sauvegarde complète locale (JSON, toutes entités + tombstones). */
export function localBackupSpec(): ExportSpec {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return {
    fileName: `scoot-backup-${stamp}.json`,
    content: JSON.stringify(repo.localBackup(), null, 2),
    mime: 'application/json',
  };
}

/** Téléverse la sauvegarde locale vers le serveur (option cloud interne). */
export async function uploadLocalBackup(token: string, fileName: string): Promise<string> {
  const res = await uploadBackup(token, fileName, repo.localBackup());
  return res.file;
}
