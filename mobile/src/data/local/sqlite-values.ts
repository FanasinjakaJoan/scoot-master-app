/**
 * Conversion des valeurs JavaScript vers les types acceptés par SQLite
 * (`bind`) et des résultats bruts de requête vers des lignes objets.
 *
 * Isolé dans son propre module (sans dépendance à SQLite) pour être testable
 * unitairement : les deux implémentations d'accès à la base locale
 * (`db.ts` natif, `db.web.ts` navigateur) partagent exactement ces règles.
 */

/** Types de valeurs acceptées en paramètre lié (`SQLiteBindValue`). */
export type BoundValue = string | number | Uint8Array | null;

/**
 * Normalise une valeur JS en valeur bindable SQLite :
 * `undefined` → `null`, booléen → `0|1`, `Date` → ISO, objet/tableau → JSON,
 * vue binaire → `Uint8Array` (les BLOB SQLite sont des `Uint8Array`).
 */
export function toBindValue(value: unknown): BoundValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return JSON.stringify(value);
}

/** Normalise une liste de paramètres liés. */
export const toBindValues = (values: readonly unknown[]): BoundValue[] => values.map(toBindValue);

/** Résultat brut d'une requête : colonnes + tableau de lignes sous forme de tuples. */
export interface RawQueryResult {
  columns: readonly string[];
  values: readonly (readonly unknown[])[];
}

/** Aplatit les résultats d'une requête en objets `{ colonne: valeur }`. */
export function rowsFromQueryResults(results: readonly RawQueryResult[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const result of results) {
    const { columns, values } = result;
    for (const tuple of values) {
      const row: Record<string, unknown> = {};
      columns.forEach((column, index) => {
        row[column] = tuple[index] ?? null;
      });
      rows.push(row);
    }
  }
  return rows;
}
