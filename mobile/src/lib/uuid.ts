/**
 * UUID v4 — généré côté appareil (permet les créations 100 % hors ligne,
 * le serveur n'impose aucun identifiant central).
 * Math.random suffit pour un identifiant d'entité métier (non cryptographique).
 */
export function uuid(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return (
    hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' + hex.slice(20)
  );
}

/** Identifiant d'appareil stable, généré une fois et stocké localement. */
export function deviceIdBase(): string {
  const rand = Array.from({ length: 8 }, () => 'abcdef0123456789'[Math.floor(Math.random() * 16)]).join('');
  return 'dev-' + rand;
}
