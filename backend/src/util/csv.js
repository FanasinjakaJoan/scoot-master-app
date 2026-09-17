'use strict';

/**
 * Génération CSV simple et sûre (échappement RFC 4180).
 * `rows` : tableau d'objets ; `columns` : [{ key, header }] ou tableau de clés.
 */
function toCsv(rows, columns) {
  const cols = (columns || (rows[0] ? Object.keys(rows[0]) : [])).map((c) =>
    typeof c === 'string' ? { key: c, header: c } : c
  );

  const esc = (v) => {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/[",\n;]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  };

  const lines = [cols.map((c) => esc(c.header)).join(',')];
  for (const row of rows) lines.push(cols.map((c) => esc(row[c.key])).join(','));
  return '\uFEFF' + lines.join('\r\n'); // BOM UTF-8 pour Excel
}

module.exports = { toCsv };
