import { incomingWins, shouldApplyChange, classifyPushResult } from '../src/data/sync/lww';

describe('LWW (Last-Write-Wins) — moteur de conflits', () => {
  test('un changement plus récent l’emporte', () => {
    expect(incomingWins({ updatedAt: '2026-09-17T12:00:00.000Z' }, { updatedAt: '2026-09-17T11:00:00.000Z' })).toBe(true);
    expect(incomingWins({ updatedAt: '2026-09-17T11:00:00.000Z' }, { updatedAt: '2026-09-17T12:00:00.000Z' })).toBe(false);
  });

  test('pas de version courante → l’entrant s’applique', () => {
    expect(incomingWins({ updatedAt: '2026-01-01T00:00:00.000Z' }, null)).toBe(true);
  });

  test('horodatage égal → tie-break déterministe par device_id', () => {
    const ts = '2026-09-17T12:00:00.000Z';
    expect(incomingWins({ updatedAt: ts, deviceId: 'dev-B' }, { updatedAt: ts, deviceId: 'dev-A' })).toBe(true);
    expect(incomingWins({ updatedAt: ts, deviceId: 'dev-A' }, { updatedAt: ts, deviceId: 'dev-B' })).toBe(false);
    expect(incomingWins({ updatedAt: ts, deviceId: 'dev-A' }, { updatedAt: ts, deviceId: 'dev-A' })).toBe(false);
  });

  test('pull : le changement serveur s’applique seulement s’il est plus récent que le local', () => {
    expect(shouldApplyChange('2026-09-17T12:00:00.000Z', '2026-09-17T11:00:00.000Z', 'upsert')).toBe(true);
    expect(shouldApplyChange('2026-09-17T11:00:00.000Z', '2026-09-17T12:00:00.000Z', 'upsert')).toBe(false);
    expect(shouldApplyChange('2026-09-17T12:00:00.000Z', null, 'upsert')).toBe(true);
    // une suppression au même horodatage s’applique (elle a gagné le LWW côté serveur)
    expect(shouldApplyChange('2026-09-17T12:00:00.000Z', '2026-09-17T12:00:00.000Z', 'delete')).toBe(true);
  });

  test('classification des résultats de push', () => {
    expect(classifyPushResult('ok', false)).toBe('applied');
    expect(classifyPushResult('conflict', false)).toBe('conflict');
    expect(classifyPushResult('error', false)).toBe('error');
  });
});
