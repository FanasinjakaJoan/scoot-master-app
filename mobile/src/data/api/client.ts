import { API_BASE_URL } from '../../lib/config';
import type { QueueOperation, ServerChange } from '../../types';

/**
 * Client HTTP de l'API Scoot Master.
 * Simple, sans dépendance : fetch + JWT dans l'en-tête Authorization.
 */

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function apiCall<T>(
  token: string | null,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE_URL + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Aucune connexion réseau.');
  }
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const message = (json as { error?: string })?.error || `Erreur ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return json as T;
}

// ---------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------

export async function login(username: string, password: string): Promise<{ token: string; user: { id: string; username: string; fullName: string; role: string } }> {
  return apiCall<{ token: string; user: { id: string; username: string; fullName: string; role: string } }>(
    null, 'POST', '/api/auth/login', { username, password }
  );
}

/**
 * Renouvelle le jeton courant (glissement de session). Le serveur re-vérifie
 * que le compte existe toujours et reste actif. En cas d'expiration → ApiError
 * 401 : l'appelant doit déclencher la réauthentification (jamais une purge locale).
 */
export function refreshToken(token: string): Promise<{ token: string; user: { id: string; username: string; fullName: string; role: string } }> {
  return apiCall<{ token: string; user: { id: string; username: string; fullName: string; role: string } }>(
    token, 'POST', '/api/auth/refresh'
  );
}

// ---------------------------------------------------------------------
// Synchronisation
// ---------------------------------------------------------------------

export interface PushResult {
  index: number;
  id: string;
  entity: string;
  status: 'ok' | 'conflict' | 'error';
  server?: Record<string, unknown> | null;
  saleNumber?: string;
  error?: string;
  deleted?: boolean;
}

export interface PushResponse {
  serverTime: string;
  results: PushResult[];
  stats: { total: number; ok: number; conflicts: number; errors: number };
}

export function pushOperations(token: string, deviceId: string, operations: QueueOperation[]): Promise<PushResponse> {
  return apiCall<PushResponse>(
    token, 'POST', '/api/sync/push',
    {
      deviceId,
      operations: operations.map((o) => ({
        entity: o.entity,
        op: o.op,
        id: o.entity_id,
        payload: o.payload,
        clientTs: o.client_ts,
        force: o.force,
      })),
    }
  );
}

export function pullChanges(token: string, since: string, cursor?: string | null, limit = 500): Promise<{ serverTime: string; changes: ServerChange[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ since, limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  return apiCall<{ serverTime: string; changes: ServerChange[]; nextCursor: string | null }>(
    token, 'GET', `/api/sync/pull?${params.toString()}`
  );
}

// ---------------------------------------------------------------------
// Exports / sauvegarde
// ---------------------------------------------------------------------

export function uploadBackup(token: string, fileName: string, data: unknown): Promise<{ ok: boolean; file: string }> {
  return apiCall<{ ok: boolean; file: string }>(token, 'POST', '/api/exports/backup', { fileName, data });
}

export function serverStatus(token: string): Promise<{ ok: boolean; service: string; time: string }> {
  return apiCall<{ ok: boolean; service: string; time: string }>(token ?? '', 'GET', '/api/health');
}

export type ManagedUser = { id: string; username: string; fullName: string; role: 'admin' | 'seller'; active: boolean };
export function listUsers(token: string) { return apiCall<{ users: ManagedUser[] }>(token, 'GET', '/api/users'); }
export function createUser(token: string, body: { username: string; fullName: string; password: string; role: 'admin' | 'seller' }) { return apiCall<{ user: ManagedUser }>(token, 'POST', '/api/users', body); }
export function updateUser(token: string, id: string, body: Partial<{ fullName: string; password: string; role: 'admin' | 'seller'; active: boolean }>) { return apiCall<{ ok: boolean; user?: ManagedUser }>(token, 'PATCH', `/api/users/${id}`, body); }

/**
 * MON profil — auto-service réservé au compte courant (nom affiché + mot de
 * passe). Endpoint dédié `PATCH /api/users/profile` : accessible à tout
 * utilisateur authentifié, sans jamais toucher au rôle ni au statut.
 */
export function updateMyProfile(token: string, body: { fullName?: string; password?: string }): Promise<{ ok: boolean; user: ManagedUser }> {
  return apiCall<{ ok: boolean; user: ManagedUser }>(token, 'PATCH', '/api/users/profile', body);
}
