/**
 * Décodage local du payload JWT (sans dépendance) — uniquement pour lire
 * l'expiration (`exp`) et anticiper le renouvellement de session.
 * La signature reste vérifiée par le serveur ; côté client `exp` ne sert
 * qu'à décider si un refresh est nécessaire avant un appel protégé.
 */

export interface JwtPayload {
  sub?: string;
  username?: string;
  role?: string;
  fullName?: string;
  exp?: number; // epoch secondes
  iat?: number;
}

function base64UrlDecode(part: string): string {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  if (typeof globalThis.atob === 'function') {
    return globalThis.atob(padded);
  }
  // Repli natif (Hermes n'expose pas atob sur toutes les versions)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Buffer } = require('buffer') as typeof import('buffer');
  return Buffer.from(padded, 'base64').toString('utf8');
}

/** Décode le payload d'un JWT ; renvoie null si malformé. */
export function decodeJwt(token: string | null | undefined): JwtPayload | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    return JSON.parse(base64UrlDecode(parts[1])) as JwtPayload;
  } catch {
    return null;
  }
}

/** Epoch (ms) d'expiration du jeton, ou null si indéterminable. */
export function jwtExpiresAt(token: string | null | undefined): number | null {
  const exp = decodeJwt(token)?.exp;
  return typeof exp === 'number' ? exp * 1000 : null;
}

/** Jeton absent, malformé (infalsifiable côté client) ou déjà expiré. */
export function isTokenExpired(token: string | null | undefined, at: number = Date.now()): boolean {
  if (!token) return true;
  const expiresAt = jwtExpiresAt(token);
  return expiresAt === null ? true : expiresAt <= at;
}

/** Jeton expire dans moins de `horizonMs` (défaut 5 min) ⇒ refresh recommandé. */
export function isTokenExpiringSoon(token: string | null | undefined, horizonMs = 5 * 60 * 1000, at: number = Date.now()): boolean {
  const expiresAt = jwtExpiresAt(token);
  return expiresAt !== null && expiresAt - horizonMs <= at;
}

/**
 * Tolérance d'horloge appliquée avant de considérer localement une session
 * comme perdue.
 *
 * L'horloge d'un téléphone (ou d'un PC) peut avancer de plusieurs minutes,
 * voire de plusieurs heures, par rapport au serveur qui a signé le jeton.
 * Sans tolérance, un jeton parfaitement valide est jugé « expiré » dès
 * l'ouverture de l'application et l'utilisateur est déconnecté quelques
 * secondes après s'être connecté. On ne se fie donc jamais à l'horloge locale
 * seule : seul le serveur tranche (via /api/auth/refresh).
 */
export const CLOCK_SKEW_TOLERANCE_MS = 24 * 60 * 60 * 1000; // 24 h

/**
 * Jeton définitivement inutilisable du point de vue du client : absent,
 * malformé, ou expiré depuis plus que la tolérance d'horloge.
 *
 * À utiliser pour décider d'un abandon de session LOCAL. Tout le reste
 * (jeton frais, bientôt expiré, ou expiré récemment) doit passer par un
 * renouvellement serveur — jamais par une déconnexion locale.
 */
export function isTokenUnusable(token: string | null | undefined, at: number = Date.now()): boolean {
  if (!token) return true;
  const expiresAt = jwtExpiresAt(token);
  if (expiresAt === null) return true; // malformé : illisible, donc inutilisable
  return expiresAt + CLOCK_SKEW_TOLERANCE_MS <= at;
}

/**
 * Le jeton doit-il être renouvelé auprès du serveur avant d'être utilisé ?
 * Vrai s'il est expiré (selon l'horloge locale) ou proche de l'échéance.
 */
export function needsRefresh(token: string | null | undefined, horizonMs = 30 * 60 * 1000, at: number = Date.now()): boolean {
  if (!token) return false;
  const expiresAt = jwtExpiresAt(token);
  if (expiresAt === null) return false;
  return expiresAt - horizonMs <= at;
}
