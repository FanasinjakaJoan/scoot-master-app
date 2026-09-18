/**
 * Utilitaires JWT locaux (décodage exp) : pilotage du refresh avant les
 * transmissions de fond (synchro, téléversement de sauvegarde).
 */

import { decodeJwt, isTokenExpired, isTokenExpiringSoon, jwtExpiresAt } from '../src/lib/jwt';

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
