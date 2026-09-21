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

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Décodage base64url → texte UTF-8, SANS dépendre de `atob` ni de `Buffer`.
 *
 * `require('buffer')` faisait échouer le bundle natif (Metro : « Unable to
 * resolve module buffer ») et donc le build APK Android, tandis qu'`atob`
 * n'existe pas sur toutes les versions d'Hermes. Ce décodeur pur JS couvre les
 * deux plateformes. Il produit directement du texte UTF-8 (et non une chaîne
 * binaire) : les payloads JWT contiennent des accents (`fullName`) qu'un
 * `JSON.parse` sur des octets bruts corromprait.
 */
function base64UrlDecode(part: string): string {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of b64) {
    const value = B64_ALPHABET.indexOf(char);
    if (value < 0) continue; // caractère hors alphabet : ignoré
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return utf8Decode(bytes);
}

/** Assemble des octets UTF-8 en chaîne JS (gère les séquences multi-octets). */
function utf8Decode(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      continue;
    }
    let codePoint = 0;
    let extra = 0;
    if ((b0 & 0xe0) === 0xc0) { codePoint = b0 & 0x1f; extra = 1; }
    else if ((b0 & 0xf0) === 0xe0) { codePoint = b0 & 0x0f; extra = 2; }
    else if ((b0 & 0xf8) === 0xf0) { codePoint = b0 & 0x07; extra = 3; }
    else { out += String.fromCharCode(b0); continue; }
    for (let k = 1; k <= extra; k++) {
      const next = bytes[i + k];
      if (next === undefined) { extra = 0; break; }
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    i += extra;
    out += String.fromCodePoint(codePoint);
  }
  return out;
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
 * Durée au-delà de laquelle un jeton expiré est jugé irrécupérable SANS même
 * interroger le serveur.
 *
 * Elle miroite la fenêtre serveur `JWT_REFRESH_GRACE` (60 jours par défaut)
 * avec un jour de marge : tant que l'expiration ne la dépasse pas, le jeton
 * est envoyé à `POST /api/auth/refresh` et SEUL le serveur tranche la fin de
 * session (compte supprimé/désactivé, secret changé, grâce dépassée). Cela
 * couvre aussi les horloges d'appareil fortement décalées : un jeton jugé
 * « expiré depuis longtemps » localement peut être parfaitement valide côté
 * serveur. Un appareil resté hors ligne plusieurs semaines retrouve donc sa
 * session au retour du réseau — y compris en pleine synchronisation — au lieu
 * d'être déconnecté par sa propre horloge.
 */
export const EXPIRED_TOKEN_GRACE_MS = 61 * 24 * 60 * 60 * 1000; // 61 jours

/**
 * Jeton définitivement inutilisable du point de vue du client : absent,
 * malformé, ou expiré depuis plus que la grâce miroir du serveur.
 *
 * À utiliser pour décider d'un abandon de session LOCAL. Tout le reste
 * (jeton frais, bientôt expiré, ou expiré récemment — même depuis plusieurs
 * semaines) doit passer par un renouvellement serveur — jamais par une
 * déconnexion locale.
 */
export function isTokenUnusable(token: string | null | undefined, at: number = Date.now()): boolean {
  if (!token) return true;
  const expiresAt = jwtExpiresAt(token);
  if (expiresAt === null) return true; // malformé : illisible, donc inutilisable
  return expiresAt + EXPIRED_TOKEN_GRACE_MS <= at;
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
