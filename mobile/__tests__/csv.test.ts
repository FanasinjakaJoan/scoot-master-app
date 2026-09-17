import { toCsv } from '../src/lib/csv';

describe('CSV local (export hors ligne)', () => {
  test('génère un CSV avec en-têtes et échappements RFC 4180', () => {
    const csv = toCsv(
      [
        { brand: 'Yamaha', model: 'XT 125', price: 2500000, desc: 'Très bon état, "révisée"' },
        { brand: 'Honda', model: 'CB, 125', price: 2350000, desc: 'avec; point-virgule' },
      ],
      [
        { key: 'brand', header: 'Marque' },
        { key: 'model', header: 'Modèle' },
        { key: 'price', header: 'Prix' },
        { key: 'desc', header: 'Description' },
      ]
    );
    expect(csv.charCodeAt(0)).toBe(0xFEFF); // BOM UTF-8
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
    expect(lines[0]).toBe('Marque,Modèle,Prix,Description');
    expect(lines[1]).toBe('Yamaha,XT 125,2500000,"Très bon état, ""révisée"""');
    expect(lines[2]).toBe('Honda,"CB, 125",2350000,"avec; point-virgule"');
  });

  test('valeurs nulles → cellules vides', () => {
    const csv = toCsv([{ a: null, b: undefined, c: 3 }], [{ key: 'a', header: 'A' }, { key: 'b', header: 'B' }, { key: 'c', header: 'C' }]);
    expect(csv.replace(/^\uFEFF/, '').split('\r\n')[1]).toBe(',,3');
  });
});
