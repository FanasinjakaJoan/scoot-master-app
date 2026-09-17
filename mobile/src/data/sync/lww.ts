/**
 * Logique pure de résolution de conflits (Last-Write-Wins) — testable sans React Native.
 *
 * Règle : les horodatages ISO-8601 UTC se comparent directement en lexique.
 * - `incoming > current` → l'entrant l'emporte
 * - `incoming < current` → le courant l'emporte (conflit côté push)
 * - égalité              → tie-break déterministe par device_id (le plus grand gagne)
 */

export interface LwwRecord {
  updatedAt: string;
  deviceId?: string | null;
}

/** L'entrant doit-il remplacer le courant ? (strict, sans force) */
export function incomingWins(incoming: LwwRecord, current: LwwRecord | null): boolean {
  if (!current) return true;
  if (incoming.updatedAt > current.updatedAt) return true;
  if (incoming.updatedAt < current.updatedAt) return false;
  // Tie-break déterministe : même horodatage → le device_id le plus grand l'emporte.
  return String(incoming.deviceId || '') > String(current.deviceId || '');
}

/** Un changement serveur doit-il être appliqué à la copie locale ? */
export function shouldApplyChange(serverUpdatedAt: string, localUpdatedAt: string | null, op: 'upsert' | 'delete'): boolean {
  if (localUpdatedAt === null) return true;
  if (op === 'delete') return serverUpdatedAt >= localUpdatedAt;
  return serverUpdatedAt > localUpdatedAt;
}

/**
 * Classe un résultat de push : 'applied' | 'conflict' | 'error'.
 * (Le serveur a déjà fait l'arbitrage LWW ; ici on interprète la réponse.)
 */
export function classifyPushResult(status: 'ok' | 'conflict' | 'error', force: boolean): 'applied' | 'conflict' | 'error' {
  if (status === 'ok') return 'applied';
  if (status === 'conflict') return 'conflict';
  return 'error';
}
