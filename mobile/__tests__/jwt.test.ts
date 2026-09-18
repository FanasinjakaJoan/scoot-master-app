/**
 * Utilitaires JWT locaux (décodage exp) : pilotage du refresh avant les
 * transmissions de fond (synchro, téléversement de sauvegarde).
 */

import {
  decodeJwt, isTokenExpired, isTokenExpiringSoon, jwtExpiresAt,
  isTokenUnusable, needsRefresh, CLOCK_SKEW_TOLERANCE_MS,
} from '../src/lib/jwt';

function makeToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.signature-fake`;
}

describe('lib/jwt', () => {
  it('décode le payload et l expiration', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = makeToken({ sub: 'u1', username: 'admin', role: 'admin', exp });
    const payload = decodeJwt(token);
    expect(payload?.sub).toBe('u1');
    expect(payload?.role).toBe('admin');
    expect(jwtExpiresAt(token)).toBe(exp * 1000);
  });

  it('détecte un jeton expiré', () => {
    const exp = Math.floor(Date.now() / 1000) - 60; // expiré depuis 1 min
    expect(isTokenExpired(makeToken({ exp }))).toBe(true);
    expect(isTokenExpired(null)).toBe(true);
    expect(isTokenExpired('non.un.jwt')).toBe(true); // malformé → traité comme expiré
    const valid = Math.floor(Date.now() / 1000) + 3600;
    expect(isTokenExpired(makeToken({ exp: valid }))).toBe(false);
  });

  it('détecte une expiration imminente (refresh recommandé)', () => {
    const soon = Math.floor((Date.now() + 2 * 60 * 1000) / 1000); // 2 min
    const far = Math.floor((Date.now() + 2 * 3600 * 1000) / 1000); // 2 h
    expect(isTokenExpiringSoon(makeToken({ exp: soon }))).toBe(true);
    expect(isTokenExpiringSoon(makeToken({ exp: far }))).toBe(false);
  });
});

/**
 * Maintien de session : l'horloge de l'appareil ne doit JAMAIS suffire à
 * déconnecter l'utilisateur. Un jeton fraîchement expiré (ou vu comme tel à
 * cause d'un décalage d'horloge) reste « utilisable » côté client : il part en
 * renouvellement vers le serveur, seul juge de la fin de session.
 */
describe('lib/jwt — tolérance d’horloge et renouvellement', () => {
  const sec = (ms: number) => Math.floor(ms / 1000);

  it('un jeton expiré depuis peu reste utilisable (décalage d’horloge probable)', () => {
    const justExpired = makeToken({ exp: sec(Date.now() - 5 * 60 * 1000) }); // 5 min
    expect(isTokenExpired(justExpired)).toBe(true); // périmé selon l'horloge locale…
    expect(isTokenUnusable(justExpired)).toBe(false); // …mais on ne déconnecte pas
  });

  it('un jeton expiré au-delà de la tolérance est déclaré inutilisable', () => {
    const ancient = makeToken({ exp: sec(Date.now() - CLOCK_SKEW_TOLERANCE_MS - 60_000) });
    expect(isTokenUnusable(ancient)).toBe(true);
  });

  it('jeton absent ou malformé : inutilisable', () => {
    expect(isTokenUnusable(null)).toBe(true);
    expect(isTokenUnusable('pas.un.jwt')).toBe(true);
  });

  it('un jeton valide de longue durée n’est ni inutilisable ni à renouveler', () => {
    const longLived = makeToken({ exp: sec(Date.now() + 30 * 86400 * 1000) }); // 30 j
    expect(isTokenUnusable(longLived)).toBe(false);
    expect(needsRefresh(longLived)).toBe(false);
  });

  it('needsRefresh déclenche le renouvellement à l’approche et après l’échéance', () => {
    expect(needsRefresh(makeToken({ exp: sec(Date.now() + 10 * 60 * 1000) }))).toBe(true); // 10 min
    expect(needsRefresh(makeToken({ exp: sec(Date.now() - 60 * 1000) }))).toBe(true); // déjà expiré
    expect(needsRefresh(makeToken({ exp: sec(Date.now() + 6 * 3600 * 1000) }))).toBe(false); // 6 h
  });
});
