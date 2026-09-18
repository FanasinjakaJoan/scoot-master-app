import { API_BASE_URL } from '../../lib/config';
import type { QueueOperation, ServerChange } from '../../types';

/**
 * Client HTTP de l'API Scoot Master.
 * Simple, sans dépendance : fetch + JWT dans l'en-tête Authorization.
 */

export class ApiError extends Error {
  status: number;
  /** true si le serveur signale une session expirée (renouvelable). */
  expired: boolean;
  /**
   * true si le serveur signale un compte supprimé ou désactivé : la session est
   * close définitivement, un renouvellement serait inutile (réauthentification).
   */
  revoked: boolean;
  constructor(status: number, message: string, expired = false, revoked = false) {
    super(message);
    this.status = status;
    this.expired = expired;
    this.revoked = revoked;
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
    const body = json as { error?: string; expired?: boolean; revoked?: boolean };
    const message = body?.error || `Erreur ${res.status}`;
    throw new ApiError(res.status, message, Boolean(body?.expired), Boolean(body?.revoked));
  }
  return json as T;
}

// ---------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------

/** Réponse de session (login / refresh) : jeton, échéance absolue et profil. */
export interface SessionResponse {
  token: string;
  /** Epoch ms d'expiration, calculé par le SERVEUR (immunise du décalage d'horloge). */
  expiresAt?: number;
  expiresIn?: number;
  user: { id: string; username: string; fullName: string; role: string };
}

export async function login(username: string, password: string): Promise<SessionResponse> {
  return apiCall<SessionResponse>(null, 'POST', '/api/auth/login', { username, password });
}

/**
 * Renouvelle le jeton courant (glissement de session).
 *
 * Le serveur accepte aussi un jeton récemment expiré (fenêtre de tolérance) :
 * une session n'est donc PAS perdue parce que l'appareil est resté hors ligne
 * ou en veille. Il re-vérifie que le compte existe toujours et reste actif.
 * Un 401 ici signifie une vraie fin de session (compte supprimé/désactivé,
 * secret changé, expiration hors tolérance) : l'appelant demande alors une
 * réauthentification — jamais une purge des données locales.
 *
 * NOTE : pour éviter le log « Failed to load resource: 401 » dans la console
 * navigateur au chargement, l'app utilise désormais `checkSession` /
 * `refreshTokenSafe` (toujours 200) pour la validation initiale et les
 * renouvellements en arrière-plan. `refreshToken` reste disponible pour
 * compatibilité et pour les tests qui vérifient le 401.
 */
export function refreshToken(token: string): Promise<SessionResponse> {
  return apiCall<SessionResponse>(token, 'POST', '/api/auth/refresh');
}

/**
 * Réponse de vérification de session SANS 401 (toujours 200).
 * `valid: true` → session maintenue, `valid: false` → fin de session.
 */
export interface CheckSessionResponse {
  valid: boolean;
  token?: string;
  expiresAt?: number;
  expiresIn?: number;
  user?: { id: string; username: string; fullName: string; role: string };
  error?: string;
  revoked?: boolean;
  expired?: boolean;
  reason?: string;
}

/**
 * Valide une session restaurée du stockage SANS jamais renvoyer 401.
 * Toujours 200 : évite le bruit « Failed to load resource: 401 » dans la
 * console du navigateur au chargement de l'app.
 */
export function checkSession(token: string): Promise<CheckSessionResponse> {
  return apiCall<CheckSessionResponse>(token, 'POST', '/api/auth/check');
}

/**
 * Renouvellement « safe » (toujours 200) pour keep-alive et retours au
 * premier plan — même sémantique que `checkSession` mais avec un jeton frais
 * si la session est valide.
 */
export function refreshTokenSafe(token: string): Promise<CheckSessionResponse> {
  return apiCall<CheckSessionResponse>(token, 'POST', '/api/auth/refresh-safe');
}

/**
 * Confirmation par mot de passe pour actions sensibles.
 * Vérifie le mot de passe courant et délivre un nouveau jeton frais.
 * Permet de débloquer une session expirée ou d'autoriser une action
 * sensible après re-saisie du mot de passe (principe sudo).
 */
export function confirmPassword(token: string, password: string): Promise<SessionResponse & { valid: boolean }> {
  return apiCall<SessionResponse & { valid: boolean }>(token, 'POST', '/api/auth/confirm-password', { password });
}

/**
 * Vérification simple du mot de passe sans renouvellement de session.
 */
export function verifyPassword(token: string, password: string): Promise<{ valid: boolean }> {
  return apiCall<{ valid: boolean }>(token, 'POST', '/api/auth/verify-password', { password });
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
