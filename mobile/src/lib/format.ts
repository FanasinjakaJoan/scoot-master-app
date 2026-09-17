/** Utilitaires de formatage (UI en français, devise Ariary par défaut). */

const nf = new Intl.NumberFormat('fr-FR');

export function formatMoney(amount: number, currency = 'MGA'): string {
  const n = nf.format(Math.round(amount || 0));
  if (!currency || currency === 'MGA') return n + ' Ar';
  return n + ' ' + currency;
}

export function formatKm(km: number | null | undefined): string {
  if (km === null || km === undefined) return '—';
  return nf.format(km) + ' km';
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) + ' ' +
    d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/** Relatif simple : « il y a 5 min », « il y a 2 h », « il y a 3 j »… */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'jamais';
  const d = new Date(iso).getTime();
  if (isNaN(d)) return 'jamais';
  const s = Math.max(0, (Date.now() - d) / 1000);
  if (s < 45) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
