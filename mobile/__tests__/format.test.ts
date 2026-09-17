import { formatMoney, formatKm, todayIsoDate } from '../src/lib/format';
import { uuid, deviceIdBase } from '../src/lib/uuid';

describe('formatage', () => {
  test('montants en Ariary', () => {
    const fr = new Intl.NumberFormat('fr-FR').format(2850000);
    expect(formatMoney(2850000)).toBe(fr + ' Ar');
    expect(formatMoney(0)).toBe('0 Ar');
    expect(formatMoney(1234567, 'USD')).toContain('USD');
  });

  test('kilométrage', () => {
    const fr = new Intl.NumberFormat('fr-FR').format(32100);
    expect(formatKm(32100)).toBe(fr + ' km');
    expect(formatKm(null)).toBe('—');
  });

  test('date du jour au format ISO (AAAA-MM-JJ)', () => {
    expect(todayIsoDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('identifiants hors ligne', () => {
  test('uuid v4 valide et unique', () => {
    const a = uuid();
    const b = uuid();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  test('device_id stable et préfixé', () => {
    const d = deviceIdBase();
    expect(d).toMatch(/^dev-[a-f0-9]{8}$/);
  });
});
