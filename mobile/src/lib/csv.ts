/**
 * Génération CSV locale (pour l'export hors ligne), RFC 4180.
 * BOM UTF-8 en préfixe pour l'ouverture propre sous Excel.
 */
export interface CsvColumn {
  key: string;
  header: string;
}

export function toCsv(rows: Record<string, unknown>[], columns: CsvColumn[]): string {
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/[",\n;]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [columns.map((c) => esc(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => esc(row[c.key])).join(','));
  return '\uFEFF' + lines.join('\r\n');
}
