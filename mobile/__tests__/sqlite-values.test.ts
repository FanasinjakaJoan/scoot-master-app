import { rowsFromQueryResults, toBindValue, toBindValues } from '../src/data/local/sqlite-values';

/**
 * Règles de conversion partagées par les accès à la base locale
 * (expo-sqlite en natif, sql.js dans le navigateur) : ce sont elles qui
 * garantissent que les mêmes valeurs JS produisent les mêmes liaisons SQLite
 * sur les deux plateformes.
 */

describe('toBindValue — normalisation des paramètres liés', () => {
  it('convertit undefined et null en NULL SQL', () => {
    expect(toBindValue(undefined)).toBeNull();
    expect(toBindValue(null)).toBeNull();
  });

  it('laisse les chaînes, nombres et binaires intacts', () => {
    expect(toBindValue('Honda')).toBe('Honda');
    expect(toBindValue(0)).toBe(0);
    const bytes = new Uint8Array([1, 2, 3]);
    expect(toBindValue(bytes)).toBe(bytes);
  });

  it('convertit les booléens en 0 / 1 (SQLite n’a pas de type booléen)', () => {
    expect(toBindValue(true)).toBe(1);
    expect(toBindValue(false)).toBe(0);
  });

  it('sérialise dates, objets et tableaux', () => {
    expect(toBindValue(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(toBindValue(['a.png', 'b.png'])).toBe('["a.png","b.png"]');
    expect(toBindValue({ photos: [] })).toBe('{"photos":[]}');
  });

  it('transforme toute vue binaire en Uint8Array', () => {
    const view = new Int16Array([1, 2]);
    const bound = toBindValue(view);
    expect(bound).toBeInstanceOf(Uint8Array);
    expect(Array.from(bound as Uint8Array)).toEqual(Array.from(new Uint8Array(view.buffer)));
  });

  it('normalise une liste complète de paramètres', () => {
    expect(toBindValues(['x', undefined, true, 12])).toEqual(['x', null, 1, 12]);
  });
});

describe('rowsFromQueryResults — lignes SQLite → objets', () => {
  it('aplatit les résultats en objets indexés par nom de colonne', () => {
    const rows = rowsFromQueryResults([
      { columns: ['id', 'brand', 'price'], values: [['a', 'Honda', 1500000], ['b', 'Yamaha', 900000]] },
    ]);
    expect(rows).toEqual([
      { id: 'a', brand: 'Honda', price: 1500000 },
      { id: 'b', brand: 'Yamaha', price: 900000 },
    ]);
  });

  it('remplace les valeurs manquantes par null (jamais undefined)', () => {
    const rows = rowsFromQueryResults([{ columns: ['a', 'b'], values: [[1]] }]);
    expect(rows).toEqual([{ a: 1, b: null }]);
  });

  it('retourne un tableau vide sans résultat (getFirstSync ⇒ null)', () => {
    expect(rowsFromQueryResults([])).toEqual([]);
  });

  it('concatène les jeux de résultats', () => {
    const rows = rowsFromQueryResults([
      { columns: ['n'], values: [[1]] },
      { columns: ['n'], values: [[2]] },
    ]);
    expect(rows).toEqual([{ n: 1 }, { n: 2 }]);
  });
});
